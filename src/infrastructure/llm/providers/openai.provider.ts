import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  LlmCompleteOptions,
  LlmCompleteResult,
  LlmEmbedOptions,
  LlmEmbedResult,
  LlmMessage,
  LlmProviderClient,
} from '../types/llm.types';

@Injectable()
export class OpenAiProvider implements LlmProviderClient {
  readonly name = 'openai' as const;
  private readonly logger = new Logger(OpenAiProvider.name);
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = this.config.get<string>('llm.openai.apiKey');
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set');
      }
      // The OpenAI SDK auto-retries transient failures (429 rate-limit + 5xx) with exponential
      // backoff and honors the Retry-After header; bump maxRetries so a long eval/batch run is
      // not killed by a single blip. timeout caps a hung request.
      this.client = new OpenAI({ apiKey, maxRetries: 5, timeout: 60_000 });
    }
    return this.client;
  }

  /**
   * GPT-5 family + o-series are REASONING models: per the OpenAI docs they REJECT `temperature`
   * (and top_p/penalties) and require `max_completion_tokens` instead of `max_tokens`. Sending the
   * old params returns a 400. Non-reasoning models (gpt-4o, gpt-4o-mini) keep the classic params.
   */
  private isReasoningModel(model: string): boolean {
    return /^(gpt-5|o\d)/i.test(model);
  }

  async complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<LlmCompleteResult> {
    const modelCode = options.model ?? this.config.get<string>('llm.openai.modelDefault') ?? '';
    const reasoning = this.isReasoningModel(modelCode);

    const start = Date.now();
    const response = await this.getClient().chat.completions.create({
      model: modelCode,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      // Reasoning models: no temperature (only default supported); cap via max_completion_tokens
      // with headroom for the hidden reasoning tokens + the visible JSON. Classic models: as before.
      ...(reasoning
        ? { max_completion_tokens: Math.max(options.maxOutputTokens ?? 8192, 8192) }
        : { temperature: options.temperature ?? 0.2, max_tokens: options.maxOutputTokens ?? 2048 }),
      ...(options.jsonMode
        ? {
            response_format: options.responseSchema
              ? {
                  type: 'json_schema' as const,
                  json_schema: {
                    name: 'structured_output',
                    schema: options.responseSchema,
                    strict: true,
                  },
                }
              : { type: 'json_object' as const },
          }
        : {}),
    });
    const latencyMs = Date.now() - start;

    const text = response.choices[0]?.message?.content ?? '';

    let parsedJson: unknown | undefined;
    if (options.jsonMode) {
      try {
        parsedJson = JSON.parse(text);
      } catch (err) {
        this.logger.warn(`Failed to parse JSON output: ${(err as Error).message}`);
      }
    }

    return {
      rawResponse: response,
      text,
      parsedJson,
      tokenUsage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      modelCode,
      provider: 'openai',
      latencyMs,
    };
  }

  async embed(text: string, options: LlmEmbedOptions): Promise<LlmEmbedResult> {
    const modelCode = options.model ?? this.config.get<string>('llm.openai.modelEmbedding') ?? '';

    const start = Date.now();
    const response = await this.getClient().embeddings.create({
      model: modelCode,
      input: text,
    });
    const latencyMs = Date.now() - start;

    return {
      embedding: response.data[0]?.embedding ?? [],
      modelCode,
      provider: 'openai',
      tokenUsage: response.usage?.total_tokens ?? 0,
      latencyMs,
    };
  }
}
