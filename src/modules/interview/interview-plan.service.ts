import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { SkillDiffService } from '../cv-jd-match/skill-diff.service';
import { buildInterviewPlan, InterviewFocusArea } from './interview-planner';
import {
  InterviewPlanItem,
  InterviewPlanRequestDto,
  InterviewPlanResponseDto,
} from './dto/interview-plan.dto';

const PROMPT_CODE = 'interview_plan_v1';

/**
 * Gap-targeted interview prep pack (R3 v1).
 * Deterministic-first: code picks WHAT to probe (buildInterviewPlan) and carries a template
 * fallback question per area; the ONE LLM call only phrases nicer questions + hints, and its
 * output is guarded — any skill not in the plan is dropped (no fabricated requirements).
 * LLM down → the full template pack still ships (llm_enhanced: false).
 * NO public route here: the platform layer (Tuấn) fronts this via /api with JWT + CV ownership.
 */
@Injectable()
export class InterviewPlanService {
  private readonly logger = new Logger(InterviewPlanService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly skillDiff: SkillDiffService,
  ) {}

  async generatePlan(
    userId: string,
    input: InterviewPlanRequestDto,
  ): Promise<InterviewPlanResponseDto> {
    const lang = input.lang ?? 'vi';

    // Recompute the diff from the review's extracted skills (same call buildSkillBreakdown
    // makes) — the stored breakdown lacks canonicals; the diff has them.
    const skills = input.review.ats_extracted?.skills_extracted ?? [];
    const diff = this.skillDiff.diff({
      cv_skills_raw: skills.map((s) => ({
        name: s.name,
        proficiency_hint: s.proficiency_hint,
        evidence_text: s.evidence_text ?? undefined,
      })),
      target_role: input.target_role,
    });
    if (diff.requirements_source !== 'role_rubric') {
      throw new Error(`INTERVIEW_PLAN_NO_RUBRIC: no rubric for role '${input.target_role}'`);
    }

    const ledger = input.review.evidence_ledger;
    const demonstrated = ledger
      ? new Set(
          ledger.items.filter((i) => i.strength === 'demonstrated').map((i) => i.skill_canonical),
        )
      : null;
    const plan = buildInterviewPlan(diff, ledger?.evidence_gap ?? null, demonstrated, lang);

    const template = this.prompts.get(PROMPT_CODE);
    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'interview_plan',
      requestPayload: { target_role: input.target_role, focus_count: plan.length, lang },
    });

    const startedAt = Date.now();
    let items: InterviewPlanItem[];
    let llmEnhanced = false;
    let tokens = 0;
    try {
      const userPrompt = this.prompts.render(PROMPT_CODE, {
        facts: JSON.stringify(plan, null, 2),
        language: lang,
      });
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        { jsonMode: true, temperature: 0.3, maxOutputTokens: 2000 },
      );
      tokens = llmResult.tokenUsage.totalTokens;
      items = this.mergeWithGuard(plan, llmResult.parsedJson);
      llmEnhanced = true;

      await this.tracing.saveAiResult({
        aiRequestId,
        userId,
        resultType: 'interview_plan',
        rawResponse: llmResult.rawResponse,
        parsedResponse: { target_role: input.target_role, language: lang, items },
        totalScore: 0,
        tokenUsage: tokens,
      });
      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: tokens,
        estimatedCost: llmResult.estimatedCostUsd,
        latencyMs: llmResult.latencyMs,
        status: 'SUCCESS',
      });
    } catch (err) {
      // Deterministic fallback IS the feature: ship the template pack, mark the LLM request failed.
      this.logger.warn(`interview_plan LLM failed — serving template pack: ${String(err)}`);
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      items = plan.map((p) => ({ ...p, question: p.template_question, good_answer_hints: [] }));
    }

    return {
      ai_request_id: aiRequestId,
      target_role: input.target_role,
      language: lang,
      items,
      llm_enhanced: llmEnhanced,
      token_usage: tokens,
    };
  }

  /** Guard: keep ONLY LLM items whose skill maps to a plan canonical; unanswered areas fall back. */
  private mergeWithGuard(plan: InterviewFocusArea[], parsedJson: unknown): InterviewPlanItem[] {
    const raw =
      parsedJson &&
      typeof parsedJson === 'object' &&
      Array.isArray((parsedJson as { items?: unknown[] }).items)
        ? ((parsedJson as { items: unknown[] }).items as Array<Record<string, unknown>>)
        : [];
    const byCanonical = new Map<string, { question: string; hints: string[] }>();
    for (const item of raw) {
      const skill = typeof item.skill === 'string' ? item.skill : '';
      const question = typeof item.question === 'string' ? item.question.trim() : '';
      if (!skill || !question) continue;
      if (!plan.some((p) => p.skill_canonical === skill)) continue; // fabricated skill → DROP
      const hints = Array.isArray(item.good_answer_hints)
        ? (item.good_answer_hints as unknown[])
            .filter((h): h is string => typeof h === 'string')
            .slice(0, 3)
        : [];
      if (!byCanonical.has(skill)) byCanonical.set(skill, { question, hints });
    }
    return plan.map((p) => {
      const llm = byCanonical.get(p.skill_canonical);
      return llm
        ? { ...p, question: llm.question, good_answer_hints: llm.hints }
        : { ...p, question: p.template_question, good_answer_hints: [] };
    });
  }
}
