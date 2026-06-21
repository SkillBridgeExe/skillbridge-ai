import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { maskPii } from '../../common/services/pii-mask';
import { InterviewScore } from './interview-scoring';
import { InterviewGapItem } from './interview-gap';
import { UnifiedDevelopmentPlan } from '../gap-report/unified-plan';
import {
  COACHING_SCHEMA,
  CoachingFacts,
  InterviewCoaching,
  buildCoachingFacts,
  groundCoaching,
} from './interview-coaching';

const PROMPT_CODE = 'interview_coaching_v1';

export interface InterviewCoachingInput {
  score: InterviewScore;
  gaps: InterviewGapItem[];
  plan: UnifiedDevelopmentPlan;
  language: 'vi' | 'en';
}

/**
 * Layer-3 of the interview chain: one schema-enforced, temp-0 LLM call that ONLY narrates a
 * coaching summary (+ a one-line why per priority), then runs it through `groundCoaching` (the
 * anti-fabrication chokepoint that owns strengths/priorities from CODE facts). Mirrors
 * `answer-insight.service.ts`:
 *   - deterministic-first: `buildCoachingFacts` (CODE) decides the facts; the LLM only phrases,
 *   - schema-enforced temp-0 `llm.complete`,
 *   - PII-mask the rendered fact strings defensively before the call AND any trace write,
 *   - best-effort tracing (`.catch(() => undefined)`),
 *   - degrade-never-throw: ANY llm/parse failure → `groundCoaching(null, facts)` (templated).
 *
 * The platform layer owns DB lifecycle; this service writes only to ai_requests / ai_results.
 */
@Injectable()
export class InterviewCoachingService {
  private readonly logger = new Logger(InterviewCoachingService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
  ) {}

  async coach(input: InterviewCoachingInput, userId = 'system'): Promise<InterviewCoaching> {
    const startedAt = Date.now();
    let aiRequestId: string | undefined;

    // CODE owns the facts — the LLM only narrates them.
    const facts: CoachingFacts = buildCoachingFacts({
      score: input.score,
      gaps: input.gaps,
      plan: input.plan,
    });

    try {
      const template = this.prompts.get(PROMPT_CODE);

      aiRequestId = await this.tracing
        .startAiRequest({
          userId,
          modelCode: '',
          promptTemplateCode: template.code,
          promptTemplateVersion: template.version,
          requestType: 'interview_coaching',
          requestPayload: {
            language: input.language,
            overall: facts.overall,
            overall_band: facts.overall_band,
          },
        })
        .catch(() => undefined);

      // PII-mask the rendered fact strings defensively (a skill/title could carry a name).
      const userPrompt = this.prompts.render(PROMPT_CODE, {
        language: input.language,
        overall: facts.overall,
        overall_band: facts.overall_band,
        strengths: maskPii(JSON.stringify(facts.strengths)),
        priorities: maskPii(
          JSON.stringify(facts.priorities.map((p) => ({ track: p.track, title: p.title }))),
        ),
        top_gaps: maskPii(JSON.stringify(facts.top_gaps)),
      });

      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          responseSchema: COACHING_SCHEMA,
          temperature: 0,
          maxOutputTokens: 400,
          model: process.env.INTERVIEW_COACHING_MODEL || undefined,
        },
      );

      const coaching = groundCoaching(llmResult.parsedJson ?? null, facts);

      if (aiRequestId) {
        await this.tracing
          .saveAiResult({
            aiRequestId,
            userId,
            resultType: 'interview_coaching',
            rawResponse: maskPii(llmResult.text ?? ''),
            parsedResponse: coaching,
            totalScore: facts.overall,
            tokenUsage: llmResult.tokenUsage.totalTokens,
          })
          .catch(() => undefined);
        await this.tracing
          .completeAiRequest(aiRequestId, {
            promptTokens: llmResult.tokenUsage.promptTokens,
            completionTokens: llmResult.tokenUsage.completionTokens,
            totalTokens: llmResult.tokenUsage.totalTokens,
            estimatedCost: llmResult.estimatedCostUsd,
            latencyMs: llmResult.latencyMs,
            status: 'SUCCESS',
            modelCode: llmResult.modelCode,
          })
          .catch(() => undefined);
      }

      return coaching;
    } catch (err) {
      if (aiRequestId) {
        await this.tracing.markFailed(aiRequestId, startedAt, err).catch(() => undefined);
      }
      this.logger.warn(`interview_coaching degraded to fallback: ${(err as Error).message}`);
      // Degrade-never-throw: deterministic templated fallback derived from CODE facts.
      return groundCoaching(null, facts);
    }
  }
}
