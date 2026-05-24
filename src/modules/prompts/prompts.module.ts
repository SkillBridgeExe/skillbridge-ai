import { Global, Module } from '@nestjs/common';
import { PromptsService } from './prompts.service';
import { TemplateRenderer } from './template-renderer';

/**
 * Loads prompt templates from `prompts/*.md` and renders them with placeholders.
 *
 * Templates are loaded once at service startup. Bumping a version creates a new file
 * (e.g. `cv_review_v2.md`) — the `ai_prompt_templates` DB row tracks which is active.
 */
@Global()
@Module({
  providers: [PromptsService, TemplateRenderer],
  exports: [PromptsService],
})
export class PromptsModule {}
