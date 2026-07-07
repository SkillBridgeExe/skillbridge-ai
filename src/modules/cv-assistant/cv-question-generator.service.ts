import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { maskPii } from '../../common/services/pii-mask';
import {
  AssistantGap,
  CompanionContext,
  CvAssistantTurn,
  analyzeBulletGaps,
  analyzeSummaryGaps,
  cvBuilderAssistantTurn1,
} from './cv-assistant';
import { groundSmartQuestions } from './cv-question-grounding';

const PROMPT_CODE = 'cv_assistant_questions_v1';

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['already_strong', 'questions'],
  properties: {
    already_strong: { type: 'boolean' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['gap', 'prompt', 'chips'],
        properties: {
          gap: { type: 'string' },
          prompt: { type: 'string' },
          chips: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const EMPTY_TURN: CvAssistantTurn = {
  message: '',
  questions: [],
  requires_user_confirmation: false,
  field_patch: null,
};

/**
 * Turn-1 upgrade: when the CV's `target_role` is known, ask ROLE-AWARE follow-up questions instead
 * of the generic rule-based ones — same anti-fabrication contract (category chips, never a planted
 * number/company/metric). Degrade-never-throw: any LLM/parse/grounding miss falls back to the
 * existing deterministic turn (`cvBuilderAssistantTurn1`), so the companion never goes silent.
 * Mirrors `CvAssistantRewriteService`'s call shape + tracing pattern (Turn-2 of this same feature).
 */
@Injectable()
export class CvQuestionGeneratorService {
  private readonly logger = new Logger(CvQuestionGeneratorService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
  ) {}

  /** ALWAYS resolves. LLM success → role-aware questions; any miss → the rule turn (fallback). */
  async generate(ctx: CompanionContext, userId = 'system'): Promise<CvAssistantTurn> {
    const fallback = cvBuilderAssistantTurn1(ctx);
    if (!fallback) return EMPTY_TURN; // page/section this skill doesn't handle — same as the rule route.
    const value = ctx.current_value!.trim(); // non-null: cvBuilderAssistantTurn1 returns null otherwise.

    const gaps: AssistantGap[] =
      ctx.section === 'summary'
        ? analyzeSummaryGaps(value, ctx.locale)
        : analyzeBulletGaps(value, ctx.locale);
    if (gaps.length === 0) return fallback; // rule already says "strong" — keep its message, don't spend the LLM.
    if (!ctx.target_role) return fallback; // no role → role-blind, keep the generic rule chips.

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
          requestType: 'cv_assistant_questions',
          requestPayload: { language: ctx.locale, section: ctx.section ?? 'projects', gaps },
        })
        .catch(() => undefined);

      const userPrompt = this.prompts.render(PROMPT_CODE, {
        target_role: ctx.target_role,
        language: ctx.locale,
        section: ctx.section ?? 'projects',
        current_value: maskPii(value),
        gaps: gaps.join(', '),
      });

      const res = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          responseSchema: SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 500,
          model: process.env.CV_ASSISTANT_MODEL || 'gpt-4o-mini',
        },
      );

      if (aiRequestId) {
        await this.tracing
          .completeAiRequest(aiRequestId, {
            promptTokens: res.tokenUsage.promptTokens,
            completionTokens: res.tokenUsage.completionTokens,
            totalTokens: res.tokenUsage.totalTokens,
            estimatedCost: res.estimatedCostUsd,
            latencyMs: res.latencyMs,
            status: 'SUCCESS',
            modelCode: res.modelCode,
          })
          .catch(() => undefined);
      }

      const grounded = groundSmartQuestions(res.parsedJson, gaps, ctx.locale);
      if (!grounded) return fallback; // model output didn't ground to any detected gap — never invent.

      return {
        message: fallback.message,
        questions: grounded.already_strong ? [] : grounded.questions,
        requires_user_confirmation: false,
        field_patch: null,
      };
    } catch (err) {
      if (aiRequestId)
        await this.tracing.markFailed(aiRequestId, startedAt, err).catch(() => undefined);
      this.logger.warn(`smart-questions degraded to rule turn: ${(err as Error).message}`);
      return fallback;
    }
  }
}
