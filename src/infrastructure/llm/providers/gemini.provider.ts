import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  LlmCompleteOptions,
  LlmCompleteResult,
  LlmEmbedOptions,
  LlmEmbedResult,
  LlmMessage,
  LlmProviderClient,
} from '../types/llm.types';

@Injectable()
export class GeminiProvider implements LlmProviderClient {
  readonly name = 'gemini' as const;
  private readonly logger = new Logger(GeminiProvider.name);
  private client: GoogleGenerativeAI | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): GoogleGenerativeAI {
    if (!this.client) {
      const apiKey = this.config.get<string>('llm.gemini.apiKey');
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set');
      }
      this.client = new GoogleGenerativeAI(apiKey);
    }
    return this.client;
  }

  async complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<LlmCompleteResult> {
    const modelCode = options.model ?? this.config.get<string>('llm.gemini.modelDefault') ?? '';
    const model = this.getClient().getGenerativeModel({
      model: modelCode,
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxOutputTokens ?? 2048,
        responseMimeType: options.jsonMode ? 'application/json' : 'text/plain',
      },
    });

    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const systemInstruction = systemMessages.map((m) => m.content).join('\n\n');

    const start = Date.now();
    const result = await model.generateContent({
      systemInstruction: systemInstruction
        ? { role: 'system', parts: [{ text: systemInstruction }] }
        : undefined,
      contents: nonSystem.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    });
    const latencyMs = Date.now() - start;

    const text = result.response.text();
    const usage = result.response.usageMetadata;

    let parsedJson: unknown | undefined;
    if (options.jsonMode) {
      try {
        parsedJson = JSON.parse(text);
      } catch (err) {
        this.logger.warn(`Failed to parse JSON output: ${(err as Error).message}`);
      }
    }

    return {
      rawResponse: result.response,
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
    const model = this.getClient().getGenerativeModel({ model: modelCode });

    const start = Date.now();
    const result = await model.embedContent(text);
    const latencyMs = Date.now() - start;

    return {
      embedding: result.embedding.values,
      modelCode,
      provider: 'gemini',
      tokenUsage: 0, // Gemini embeddings API doesn't return usage
      latencyMs,
    };
  }
}
