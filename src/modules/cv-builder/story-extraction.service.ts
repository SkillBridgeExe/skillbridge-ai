import { Injectable, Logger } from '@nestjs/common';
import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { maskPii } from '../../common/services/pii-mask';
import { ExtractedProject, gateProjects, ProposedProject } from './project-extractor';
import { ExtractedCert, extractCerts } from './cert-extractor';

const PROMPT_CODE = 'cv_story_project';

export interface StoryExtractionResult {
  projects: ExtractedProject[];
  certifications: ExtractedCert[];
  degraded: boolean;
}

/**
 * Story→CV slice 2 orchestrator. Certs are pure-code (always run). Projects use ONE LLM call to propose
 * prose, then the deterministic gate decides what survives. LLM/parse failure → projects:[] + degraded
 * (certs still returned). No fabrication; degrade-never-throw. Mirrors CvIntakeService's trace-then-degrade
 * shape.
 */
@Injectable()
export class StoryExtractionService {
  private readonly logger = new Logger(StoryExtractionService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly taxonomy: SkillTaxonomyService,
    private readonly tracing: TracingService,
  ) {}

  private resolve = (raw: string): string | null =>
    this.taxonomy.lookupByAliasKey(SkillTaxonomyService.normalizeKey(raw)) ?? null;

  async extract(
    story: string,
    language: 'vi' | 'en',
    userId: string,
  ): Promise<StoryExtractionResult> {
    const certifications = extractCerts(story); // pure, always
    let projects: ExtractedProject[] = [];
    let degraded = false;
    const startedAt = Date.now();
    let aiRequestId: string | undefined;
    try {
      const template = this.prompts.get(PROMPT_CODE);
      aiRequestId = await this.tracing
        .startAiRequest({
          userId,
          modelCode: '',
          promptTemplateCode: template.code,
          promptTemplateVersion: template.version,
          requestType: 'cv_story_project',
          requestPayload: { output_lang: language },
        })
        .catch(() => undefined);

      const userPrompt = this.prompts.render(PROMPT_CODE, {
        narrative: maskPii(story),
        output_lang: language,
      });
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          temperature: 0,
          maxOutputTokens: 600,
          model: process.env.CV_INTAKE_MODEL || undefined,
        },
      );
      const parsed = (llmResult.parsedJson ?? null) as { projects?: ProposedProject[] } | null;
      const proposed = Array.isArray(parsed?.projects) ? parsed!.projects : [];
      projects = gateProjects(proposed, story, this.resolve); // grounded against RAW story

      if (aiRequestId) {
        // Promise.resolve(...) tolerates both a real Promise and a plain-value test double;
        // .catch swallows telemetry failures so they never flip an otherwise-successful gate to degraded.
        await Promise.resolve(
          this.tracing.completeAiRequest(aiRequestId, {
            promptTokens: llmResult.tokenUsage?.promptTokens ?? 0,
            completionTokens: llmResult.tokenUsage?.completionTokens ?? 0,
            totalTokens: llmResult.tokenUsage?.totalTokens ?? 0,
            estimatedCost: llmResult.estimatedCostUsd,
            latencyMs: llmResult.latencyMs ?? 0,
            status: 'SUCCESS',
            modelCode: llmResult.modelCode,
          }),
        ).catch(() => undefined);
      }
    } catch (err) {
      degraded = true;
      if (aiRequestId) {
        await Promise.resolve(this.tracing.markFailed(aiRequestId, startedAt, err)).catch(
          () => undefined,
        );
      }
      this.logger.warn(`story project extraction degraded: ${(err as Error).message}`);
    }
    return { projects, certifications, degraded };
  }
}
