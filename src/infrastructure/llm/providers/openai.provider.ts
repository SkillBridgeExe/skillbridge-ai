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
      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  async complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<LlmCompleteResult> {
    const modelCode = options.model ?? this.config.get<string>('llm.openai.modelDefault') ?? '';

    const start = Date.now();
    const response = await this.getClient().chat.completions.create({
      model: modelCode,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxOutputTokens ?? 2048,
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
