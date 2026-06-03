import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import {
  LlmCompleteOptions,
  LlmCompleteResult,
  LlmEmbedOptions,
  LlmEmbedResult,
  LlmMessage,
  LlmProviderClient,
} from '../types/llm.types';

/**
 * Gemini provider — uses the UNIFIED `@google/genai` SDK.
 *
 * NOTE: the legacy `@google/generative-ai` SDK is EOL (2025) and has been
 * removed. New API shape:
 *   const ai = new GoogleGenAI({ apiKey });
 *   const res = await ai.models.generateContent({ model, contents, config });
 *   res.text            // generated text
 *   res.usageMetadata   // token counts
 */
@Injectable()
export class GeminiProvider implements LlmProviderClient {
  readonly name = 'gemini' as const;
  private readonly logger = new Logger(GeminiProvider.name);
  private client: GoogleGenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): GoogleGenAI {
    if (!this.client) {
      const apiKey = this.config.get<string>('llm.gemini.apiKey');
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set');
      }
      this.client = new GoogleGenAI({ apiKey });
    }
    return this.client;
  }

  /**
   * Retry transient Gemini errors (429 RESOURCE_EXHAUSTED, 500 INTERNAL,
   * 503 UNAVAILABLE) with exponential backoff: 1s → 2s → 4s, up to 3 attempts.
   * Non-transient errors (400 bad model/request, 401/403 auth) throw immediately.
   */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 5;
    const TRANSIENT = new Set([429, 500, 503]);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const code = this.statusCode(err);
        if (code === undefined || !TRANSIENT.has(code) || attempt === MAX_ATTEMPTS) throw err;
        // Honor the server-suggested retry delay (429 RetryInfo); else exponential backoff. Cap 60s.
        const backoff = 1000 * 2 ** (attempt - 1);
        const delayMs = Math.min(Math.max(this.retryDelayMs(err) ?? backoff, backoff), 60_000);
        this.logger.warn(
          `${label}: transient ${code}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(delayMs / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastErr;
  }

  /** Best-effort HTTP status from a @google/genai ApiError (status/code field or JSON in message). */
  private statusCode(err: unknown): number | undefined {
    const e = err as { status?: number; code?: number; message?: string };
    if (typeof e?.status === 'number') return e.status;
    if (typeof e?.code === 'number') return e.code;
    const m = (e?.message ?? '').match(/"code"\s*:\s*(\d+)/);
    return m ? Number(m[1]) : undefined;
  }

  /** Server-suggested retry delay in ms (429 RetryInfo: "retryDelay":"40s" or "retry in 40s"). */
  private retryDelayMs(err: unknown): number | undefined {
    const msg = (err as { message?: string })?.message ?? '';
    const m =
      msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ??
      msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
    return m ? Math.ceil(Number(m[1])) * 1000 : undefined;
  }

  async complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<LlmCompleteResult> {
    const modelCode = options.model ?? this.config.get<string>('llm.gemini.modelDefault') ?? '';

    const systemInstruction = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const start = Date.now();
    const response = await this.withRetry('gemini.complete', () =>
      this.getClient().models.generateContent({
        model: modelCode,
        contents,
        config: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxOutputTokens ?? 2048,
          responseMimeType: options.jsonMode ? 'application/json' : 'text/plain',
          // #21: constrain output shape at the model level when a schema is supplied.
          ...(options.jsonMode && options.responseSchema
            ? { responseJsonSchema: options.responseSchema }
            : {}),
          // Disable "thinking": our calls are deterministic extraction/scoring (temp ~0.1),
          // they don't benefit from it, and on 2.5+ models thinking tokens otherwise consume
          // maxOutputTokens and truncate the JSON (finishReason=MAX_TOKENS).
          thinkingConfig: { thinkingBudget: 0 },
          ...(systemInstruction ? { systemInstruction } : {}),
        },
      }),
    );
    const latencyMs = Date.now() - start;

    const text = response.text ?? '';
    const usage = response.usageMetadata;
    const finishReason = String(response.candidates?.[0]?.finishReason ?? '');
    const blockReason = response.promptFeedback?.blockReason;

    // A blocked prompt / empty candidate set is a hard failure, not an empty completion.
    if (!response.candidates || response.candidates.length === 0) {
      throw new Error(
        `Gemini returned no candidates${blockReason ? ` (blockReason=${blockReason})` : ''}; model=${modelCode}`,
      );
    }

    let parsedJson: unknown | undefined;
    if (options.jsonMode) {
      // Truncation (MAX_TOKENS) or a safety/recitation stop yields invalid/partial JSON.
      // Surface it as an error so callers fail loudly instead of scoring an empty document.
      if (finishReason && finishReason !== 'STOP') {
        throw new Error(
          `Gemini JSON output not usable (finishReason=${finishReason}); model=${modelCode}. ` +
            `If MAX_TOKENS, raise maxOutputTokens.`,
        );
      }
      try {
        parsedJson = JSON.parse(text);
      } catch (err) {
        // Note: do NOT log the raw text — it derives from CV content (PII). finishReason is enough to diagnose.
        throw new Error(
          `Gemini JSON parse failed (${(err as Error).message}); model=${modelCode}, finishReason=${finishReason}`,
        );
      }
    }

    return {
      rawResponse: response,
      text,
      parsedJson,
      tokenUsage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      modelCode,
      provider: 'gemini',
      latencyMs,
    };
  }

  async embed(text: string, options: LlmEmbedOptions): Promise<LlmEmbedResult> {
    const modelCode = options.model ?? this.config.get<string>('llm.gemini.modelEmbedding') ?? '';

    const start = Date.now();
    const response = await this.withRetry('gemini.embed', () =>
      this.getClient().models.embedContent({
        model: modelCode,
        contents: text,
      }),
    );
    const latencyMs = Date.now() - start;

    const embedding = response.embeddings?.[0]?.values ?? [];

    return {
      embedding,
      modelCode,
      provider: 'gemini',
      tokenUsage: 0, // Gemini embeddings API doesn't return token usage
      latencyMs,
    };
  }
}
