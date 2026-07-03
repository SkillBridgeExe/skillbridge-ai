import { Global, Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { OpenAiProvider } from './providers/openai.provider';

/**
 * LLM abstraction layer.
 *
 * Feature modules inject `LlmService` only. They do not depend on provider SDKs directly.
 */
@Global()
@Module({
  providers: [OpenAiProvider, LlmService],
  exports: [LlmService],
})
export class LlmModule {}
