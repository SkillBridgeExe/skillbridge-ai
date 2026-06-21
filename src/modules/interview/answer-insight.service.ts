import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { maskPii } from '../../common/services/pii-mask';
import { AnswerSignals } from './answer-analyzer';
import { ANSWER_INSIGHT_SCHEMA, AnswerInsight, groundAnswerInsight } from './answer-insight';

const PROMPT_CODE = 'answer_insight_v1';

export interface AnswerInsightInput {
  answer: string;
  question?: string;
  target_dimension?: string;
  language: 'vi' | 'en';
  /** Layer-1 signals — passed to the model as grounding AND used by code to derive evidence_quality. */
  signals: AnswerSignals;
}

/**
 * Layer-2 of the Answer Analyzer: one schema-enforced, temp-0, PII-masked LLM call that judges ONLY
 * the nuance of an answer, then runs it through `groundAnswerInsight` (the anti-fabrication
 * chokepoint). Mirrors `resource-curation/curation.service.ts`:
 *   - schema-enforced temp-0 `llm.complete`,
 *   - best-effort tracing (`.catch(() => undefined)`),
 *   - degrade-never-throw: ANY llm/parse failure → `groundAnswerInsight(null, signals)`.
 *
 * The platform layer owns DB lifecycle; this service writes only to ai_requests / ai_results.
 */
@Injectable()
export class AnswerInsightService {
  private readonly logger = new Logger(AnswerInsightService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
  ) {}

  async judge(input: AnswerInsightInput, userId = 'system'): Promise<AnswerInsight> {
    const startedAt = Date.now();
    let aiRequestId: string | undefined;
    // PII-mask the answer + question BEFORE render AND before any trace write (audit F3).
    const maskedAnswer = maskPii(input.answer ?? '');
    const maskedQuestion = input.question ? maskPii(input.question) : '(no question provided)';

    try {
      const template = this.prompts.get(PROMPT_CODE);

      aiRequestId = await this.tracing
        .startAiRequest({
          userId,
          modelCode: '',
          promptTemplateCode: template.code,
          promptTemplateVersion: template.version,
          requestType: 'answer_insight',
          requestPayload: {
            language: input.language,
            target_dimension: input.target_dimension ?? null,
          },
        })
        .catch(() => undefined);

      const userPrompt = this.prompts.render(PROMPT_CODE, {
        language: input.language,
        question: maskedQuestion,
        answer: maskedAnswer,
        target_dimension: input.target_dimension ?? '(unspecified)',
        signals_summary: JSON.stringify(summarizeSignals(input.signals)),
      });

      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          responseSchema: ANSWER_INSIGHT_SCHEMA,
          temperature: 0,
          maxOutputTokens: 300,
          model: process.env.ANSWER_INSIGHT_MODEL || undefined,
        },
      );

      const insight = groundAnswerInsight(llmResult.parsedJson ?? null, input.signals);

      if (aiRequestId) {
        await this.tracing
          .saveAiResult({
            aiRequestId,
            userId,
            resultType: 'answer_insight',
            rawResponse: maskPii(llmResult.text ?? ''),
            parsedResponse: insight,
            totalScore: insight.relevance,
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

      return insight;
    } catch (err) {
      if (aiRequestId) {
        await this.tracing.markFailed(aiRequestId, startedAt, err).catch(() => undefined);
      }
      this.logger.warn(`answer_insight degraded to fallback: ${(err as Error).message}`);
      // Degrade-never-throw: deterministic safe fallback derived from Layer 1.
      return groundAnswerInsight(null, input.signals);
    }
  }
}

/**
 * A compact, JSON-safe view of the Layer-1 signals to ground the model — only the fields that help
 * it judge nuance. The model is told NOT to recompute these (code owns them).
 */
function summarizeSignals(s: AnswerSignals): Record<string, unknown> {
  return {
    word_count: s.word_count,
    conciseness: s.conciseness,
    filler_count: s.filler.count,
    hedging_count: s.hedging.count,
    jd_coverage: s.jd_term_hits.coverage,
    jd_missed: s.jd_term_hits.missed,
    star_complete: s.star.complete,
    has_concrete_example: s.has_concrete_example,
    rambling_risk: s.flags.rambling_risk,
  };
}
