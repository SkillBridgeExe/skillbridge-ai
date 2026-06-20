import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { CurationInput, CuratedResource, groundCuration } from './curation-scoring';
import { levelsToCraap } from './curation-levels';
import { providerTier, routeValidation } from './curation-signals';

const PROMPT_CODE = 'resource_curation_v1';

/**
 * Offline resource-curation turn: render resource_curation_v1 over a candidate → schema-light LLM call at
 * temperature 0 → anchored-level adapter → deterministic groundCuration (owns score + verified/pending/
 * flagged + anti-fabrication) → traced to ai_requests/ai_results.
 *
 * Deterministic-first: the LLM only READS + rates per CRAAP level; reproducible CODE owns the decision.
 * DEGRADE-NEVER-THROW: a failed LLM call falls back to groundCuration(null) (safe pending/flagged — never
 * auto-verifies) so one bad candidate can't abort an offline batch. The confidence-band router + signals
 * (providerTier/freshness/liveness) are applied by the OFFLINE BACKFILL, not here (they need IO/date the
 * pure curation turn shouldn't own).
 */
@Injectable()
export class CurationService {
  private readonly logger = new Logger(CurationService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
  ) {}

  async curate(input: CurationInput, userId = 'system'): Promise<CuratedResource> {
    const startedAt = Date.now();
    const template = this.prompts.get(PROMPT_CODE);

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '', // backfilled on completion
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'resource_curation',
      requestPayload: { provider: input.provider, skills: input.skills, url: input.url ?? null },
    });

    try {
      const userPrompt = this.prompts.render(PROMPT_CODE, {
        resource: JSON.stringify(
          {
            title: input.title,
            provider: input.provider,
            description: input.description ?? '',
            skills: input.skills,
            url: input.url ?? '',
          },
          null,
          2,
        ),
      });

      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          temperature: 0, // assessment, not generation → consistency (research); discretized levels add a moat
          maxOutputTokens: 700,
          model: process.env.CURATION_MODEL || undefined,
        },
      );

      // anchored level → 0-1 float, THEN the deterministic core owns the score + decision. Only adapt when the
      // model returned a craap object — else let groundCuration's missing-craap fallback fire (→ pending).
      const parsed = (llmResult.parsedJson ?? null) as Record<string, unknown> | null;
      const adapted =
        parsed && typeof parsed.craap === 'object' && parsed.craap !== null
          ? { ...parsed, craap: levelsToCraap(parsed.craap) }
          : parsed;
      const result = this.gate(groundCuration(adapted, input), input);

      await this.tracing.saveAiResult({
        aiRequestId,
        userId,
        resultType: 'resource_curation',
        rawResponse: llmResult.text,
        parsedResponse: result,
        totalScore: result.quality_score,
        tokenUsage: llmResult.tokenUsage.totalTokens,
      });
      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: llmResult.tokenUsage.totalTokens,
        estimatedCost: llmResult.estimatedCostUsd,
        latencyMs: llmResult.latencyMs,
        status: 'SUCCESS',
        modelCode: llmResult.modelCode,
      });
      return result;
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      this.logger.warn(`resource_curation degraded to fallback: ${(err as Error).message}`);
      return this.gate(groundCuration(null, input), input); // safe pending/flagged — never auto-verify on failure
    }
  }

  /** The single verify CHOKEPOINT: routeValidation is the ONLY path to 'verified' — the safe-for-commerce
   * gate (quality >= AUTO_VERIFY_BAND + a T1/T2 provider) applied on top of the core content decision, so a
   * mediocre / unknown-provider (T3) resource the core would auto-verify at >=60 stays `pending`. */
  private gate(curated: CuratedResource, input: CurationInput): CuratedResource {
    return {
      ...curated,
      validation_status: routeValidation(curated, { providerTier: providerTier(input.provider) }),
    };
  }
}
