import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { maskPii } from '../../common/services/pii-mask';
import { AssistantGap, CvAnswer, Language } from './cv-assistant';
import {
  FieldPatch,
  RewriteModelOutput,
  groundCvAssistantAnswers,
  groundCvRewrite,
} from './cv-assistant-rewrite';

const PROMPT_CODE: Record<'bullet' | 'summary', string> = {
  bullet: 'cv_assistant_rewrite_v1',
  summary: 'cv_summary_rewrite_v1',
};

/** the model may output exactly these two fields — code verifies them against the allowed facts. */
export const REWRITE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['after', 'used_facts'],
  properties: {
    after: { type: 'string', maxLength: 400 },
    used_facts: { type: 'array', items: { type: 'string' } },
  },
};

export interface CvAssistantRewriteInput {
  /** the original bullet text. */
  before: string;
  /** the user's Turn-1 answers (chips + details). */
  answers: CvAnswer[];
  /** CV field path this patch targets (e.g. 'projects[0].bullets[0]'). */
  target: string;
  language: Language;
  /** the CV's language for the rewritten text + grounded facts (defaults to `language` when absent). */
  outputLang?: Language;
  /** which kind of field is being rewritten — selects the prompt (default 'bullet'). */
  kind?: 'bullet' | 'summary';
}

export type CvAssistantRewriteResult =
  | { ok: true; field_patch: FieldPatch }
  | {
      ok: false;
      reason: 'NEEDS_DETAIL' | 'UNGROUNDED' | 'DEGRADED';
      gap?: AssistantGap;
      message: string;
    };

const REASK_TECH: Record<Language, string> = {
  en: 'Which specific tech did you use (e.g. Node.js, React, PostgreSQL)?',
  vi: 'Bạn dùng công nghệ cụ thể nào (vd Node.js, React, PostgreSQL)?',
};
const REASK_STRENGTH: Record<Language, string> = {
  en: 'Which specific skills are your strengths (e.g. React, Python, SQL)?',
  vi: 'Thế mạnh cụ thể của bạn là kỹ năng nào (vd React, Python, SQL)?',
};
const REASK_GENERIC: Record<Language, string> = {
  en: 'Tell me a bit more so I can rewrite it without inventing anything.',
  vi: 'Cho mình thêm chút thông tin để viết lại mà không bịa gì nhé.',
};
const DEGRADED_MSG: Record<Language, string> = {
  en: 'I could not rewrite this right now — please try again in a moment.',
  vi: 'Mình tạm chưa viết lại được — bạn thử lại sau chút nhé.',
};
const WHY: Record<Language, string> = {
  en: 'Rewritten from your answers — nothing fabricated.',
  vi: 'Viết lại từ câu trả lời của bạn — không bịa gì.',
};

/**
 * Turn-2 of the CV Builder Assistant: ground the user's answers, then make ONE schema-enforced, temp-0
 * LLM call to rewrite the bullet, then run the rewrite through `groundCvRewrite` (anti-fabrication
 * chokepoint). A bare/thin answer → re-ask WITHOUT calling the LLM. Degrade-never-throw: any LLM/parse
 * failure or an ungrounded rewrite → a safe follow-up, never a fabricated patch. Mirrors AnswerInsightService.
 */
@Injectable()
export class CvAssistantRewriteService {
  private readonly logger = new Logger(CvAssistantRewriteService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
  ) {}

  async rewrite(
    input: CvAssistantRewriteInput,
    userId = 'system',
  ): Promise<CvAssistantRewriteResult> {
    const language = input.language; // UI language → user-facing re-ask / degraded messages.
    const outputLang = input.outputLang ?? language; // CV language → grounded facts + the rewritten text.
    const grounded = groundCvAssistantAnswers(input.answers, outputLang);

    // re-ask BEFORE spending any LLM call (deterministic gate).
    if (grounded.needs_detail.length > 0) {
      const gap = grounded.needs_detail[0];
      return {
        ok: false,
        reason: 'NEEDS_DETAIL',
        gap,
        message: gap === 'strength' ? REASK_STRENGTH[language] : REASK_TECH[language],
      };
    }
    if (grounded.facts.length === 0) {
      return { ok: false, reason: 'NEEDS_DETAIL', message: REASK_GENERIC[language] };
    }

    const startedAt = Date.now();
    const promptCode = PROMPT_CODE[input.kind ?? 'bullet'];
    let aiRequestId: string | undefined;
    try {
      const template = this.prompts.get(promptCode);
      aiRequestId = await this.tracing
        .startAiRequest({
          userId,
          modelCode: '',
          promptTemplateCode: template.code,
          promptTemplateVersion: template.version,
          requestType: 'cv_assistant_rewrite',
          requestPayload: { language, target: input.target, fact_count: grounded.facts.length },
        })
        .catch(() => undefined);

      const userPrompt = this.prompts.render(promptCode, {
        language: outputLang,
        before: maskPii(input.before),
        facts: grounded.facts.map((f) => `- ${f}`).join('\n'),
      });

      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          responseSchema: REWRITE_SCHEMA,
          temperature: 0,
          maxOutputTokens: 300,
          model: process.env.CV_ASSISTANT_MODEL || undefined,
        },
      );

      const parsed = (llmResult.parsedJson ?? null) as Partial<RewriteModelOutput> | null;
      if (!parsed || typeof parsed.after !== 'string')
        throw new Error('cv_assistant_rewrite: bad model output');

      const verdict = groundCvRewrite(
        input.before,
        {
          after: parsed.after,
          used_facts: Array.isArray(parsed.used_facts) ? parsed.used_facts : [],
        },
        grounded,
        { target: input.target, why: WHY[language] },
      );

      if (aiRequestId) {
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

      if (verdict.ok) return { ok: true, field_patch: verdict.field_patch };
      // the model fabricated something → do NOT emit a patch; ask for more grounded info.
      return { ok: false, reason: 'UNGROUNDED', message: REASK_GENERIC[language] };
    } catch (err) {
      if (aiRequestId)
        await this.tracing.markFailed(aiRequestId, startedAt, err).catch(() => undefined);
      this.logger.warn(`cv_assistant_rewrite degraded: ${(err as Error).message}`);
      return { ok: false, reason: 'DEGRADED', message: DEGRADED_MSG[language] };
    }
  }
}
