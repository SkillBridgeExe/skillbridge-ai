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
    const response = await this.getClient().models.generateContent({
      model: modelCode,
      contents,
      config: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxOutputTokens ?? 2048,
        responseMimeType: options.jsonMode ? 'application/json' : 'text/plain',
        ...(systemInstruction ? { systemInstruction } : {}),
      },
    });
    const latencyMs = Date.now() - start;

    const text = response.text ?? '';
    const usage = response.usageMetadata;

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
    const response = await this.getClient().models.embedContent({
      model: modelCode,
      contents: text,
    });
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
