import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiProvider } from './providers/gemini.provider';
import { OpenAiProvider } from './providers/openai.provider';
import {
  LlmCompleteOptions,
  LlmCompleteResult,
  LlmEmbedOptions,
  LlmEmbedResult,
  LlmMessage,
  LlmProvider,
  LlmProviderClient,
} from './types/llm.types';
import { ERROR_CODES } from '../../common/constants/error-codes';

/**
 * Provider-agnostic LLM facade.
 * Feature modules use ONLY this service; they do not import Gemini/OpenAI SDKs directly.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly defaultProvider: LlmProvider;

  constructor(
    private readonly config: ConfigService,
    private readonly gemini: GeminiProvider,
    private readonly openai: OpenAiProvider,
  ) {
    this.defaultProvider = (this.config.get<string>('llm.providerDefault') ??
      'gemini') as LlmProvider;
  }

  async complete(
    messages: LlmMessage[],
    options: LlmCompleteOptions = {},
  ): Promise<LlmCompleteResult> {
    const provider = this.resolveProvider(options.provider);
    try {
      return await provider.complete(messages, options);
    } catch (err) {
      this.logger.error(
        `LLM complete failed (provider=${provider.name}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new ServiceUnavailableException({
        code: ERROR_CODES.AI_SERVICE_UNAVAILABLE,
        message: `LLM call failed: ${(err as Error).message}`,
      });
    }
  }

  async embed(text: string, options: LlmEmbedOptions = {}): Promise<LlmEmbedResult> {
    const provider = this.resolveProvider(options.provider);
    try {
      return await provider.embed(text, options);
    } catch (err) {
      this.logger.error(
        `LLM embed failed (provider=${provider.name}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new ServiceUnavailableException({
        code: ERROR_CODES.EMBEDDING_FAILED,
        message: `Embedding failed: ${(err as Error).message}`,
      });
    }
  }

  private resolveProvider(name?: LlmProvider): LlmProviderClient {
    const chosen = name ?? this.defaultProvider;
    switch (chosen) {
      case 'gemini':
        return this.gemini;
      case 'openai':
        return this.openai;
      default:
        throw new Error(`Unknown LLM provider: ${chosen}`);
    }
  }
}
