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

/**
 * Pure: assemble the chat.completions params for a model + options. Exported for unit testing.
 *
 * GPT-5 family + o-series are REASONING models: per the OpenAI docs they REJECT `temperature`/`seed`
 * (and top_p/penalties) and require `max_completion_tokens` instead of `max_tokens`. Non-reasoning
 * models (gpt-4o, gpt-4o-mini) keep the classic params AND honor `seed` (best-effort determinism).
 * Prod call sites pass no `seed`, so prod behavior is unchanged; `seed` exists for the determinism path.
 */
export function buildChatParams(
  model: string,
  options: { temperature?: number; maxOutputTokens?: number; seed?: number },
): Record<string, unknown> {
  const reasoning = /^(gpt-5|o\d)/i.test(model);
  if (reasoning) {
    return { max_completion_tokens: Math.max(options.maxOutputTokens ?? 8192, 8192) };
  }
  return {
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxOutputTokens ?? 2048,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  };
}

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

  async complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<LlmCompleteResult> {
    const modelCode = options.model ?? this.config.get<string>('llm.openai.modelDefault') ?? '';

    const start = Date.now();
    const response = await this.getClient().chat.completions.create({
      model: modelCode,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...buildChatParams(modelCode, {
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
        seed: options.seed,
      }),
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
      const finishReason = response.choices[0]?.finish_reason;
      // Fail loudly (mirror the Gemini provider): an empty or length-truncated body must NOT be
      // returned as `undefined` and silently coerced to an empty document downstream.
      if (!text || finishReason === 'length') {
        throw new Error(
          `OpenAI returned ${!text ? 'empty' : 'truncated (finish_reason=length)'} JSON output; model=${modelCode}`,
        );
      }
      try {
        parsedJson = JSON.parse(text);
      } catch (err) {
        throw new Error(`OpenAI JSON parse failed (${(err as Error).message}); model=${modelCode}`);
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
    // Dimension contract: the vector MUST match the pgvector column width. The `dimensions`
    // param makes OpenAI shorten via Matryoshka AND return a unit-length vector (verified:
    // no manual re-normalization needed on this path).
    const dimensions = options.dimensions ?? this.config.get<number>('vector.dimension');

    const start = Date.now();
    const response = await this.getClient().embeddings.create({
      model: modelCode,
      input: text,
      ...(dimensions ? { dimensions: Number(dimensions) } : {}),
    });
    const latencyMs = Date.now() - start;

    let embedding = response.data[0]?.embedding ?? [];
    if (dimensions && embedding.length !== Number(dimensions)) {
      throw new Error(
        `Embedding dimension contract violated: expected ${dimensions}, got ${embedding.length} (model=${modelCode})`,
      );
    }
    // Defensive: should already be unit-length; re-normalize only if it measurably is not.
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    if (norm > 0 && Math.abs(norm - 1) > 1e-3) {
      embedding = embedding.map((v) => v / norm);
    }

    return {
      embedding,
      modelCode,
      provider: 'openai',
      tokenUsage: response.usage?.total_tokens ?? 0,
      latencyMs,
    };
  }
}
