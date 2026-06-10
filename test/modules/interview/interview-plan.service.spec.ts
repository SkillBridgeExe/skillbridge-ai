import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import { SkillDiffService } from '../../../src/modules/cv-jd-match/skill-diff.service';
import { InterviewPlanService } from '../../../src/modules/interview/interview-plan.service';
import { CvReviewParsedResponse } from '../../../src/modules/cv-review/dto/cv-review-response.dto';

/**
 * Unit spec for InterviewPlanService.
 * All LLM/Prompts/Tracing collaborators are mocked (jest objects, positional `as never`).
 * Real SkillDiffService is booted (same pattern as interview-planner.spec.ts / Task 1).
 */
describe('InterviewPlanService', () => {
  let skillDiff: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    skillDiff = new SkillDiffService(normalizer, rubrics);
  });

  /**
   * Minimal fixture — only the fields InterviewPlanService actually reads:
   *   ats_extracted.skills_extracted, evidence_ledger, (language unused by service itself)
   * Everything else cast as never to keep the fixture concise.
   */
  const makeReview = (opts?: {
    skills?: Array<{ name: string; proficiency_hint: string }>;
    evidenceGap?: string[];
    demonstratedCanonicals?: string[];
  }): CvReviewParsedResponse => {
    const skills = opts?.skills ?? [
      { name: 'React', proficiency_hint: 'advanced' },
      { name: 'JavaScript', proficiency_hint: 'beginner' },
    ];
    const evidenceGap = opts?.evidenceGap ?? ['react'];
    const demonstratedCanonicals = opts?.demonstratedCanonicals ?? [];
    return {
      ats_extracted: {
        skills_extracted: skills.map((s) => ({
          name: s.name,
          proficiency_hint: s.proficiency_hint,
          evidence_text: null,
        })),
      } as never,
      evidence_ledger: {
        items: demonstratedCanonicals.map((c) => ({
          skill_canonical: c,
          display_name: c,
          sources: [],
          strength: 'demonstrated' as const,
          most_recent_year: null,
        })),
        evidence_gap: evidenceGap,
      },
    } as never as CvReviewParsedResponse;
  };

  function build(llmOverride?: jest.Mock) {
    const llm = {
      complete:
        llmOverride ??
        jest.fn().mockResolvedValue({
          parsedJson: { items: [] },
          rawResponse: '{}',
          tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          latencyMs: 50,
          estimatedCostUsd: 0.001,
        }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({
        code: 'interview_plan',
        version: 1,
        meta: { system: 'sys-prompt' },
        body: '',
      }),
      render: jest.fn().mockReturnValue('USER_PROMPT'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-plan-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      saveAiResult: jest.fn().mockResolvedValue('res-plan-1'),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    const service = new InterviewPlanService(
      llm as never,
      prompts as never,
      tracing as never,
      skillDiff,
    );
    return { service, llm, prompts, tracing };
  }

  it('happy path: LLM questions mapped by canonical; llm_enhanced true; tracing called', async () => {
    // Build plan via a real diff first so we know canonicals
    const review = makeReview();
    // The service will produce a plan with real canonicals from frontend_developer rubric.
    // We'll mock the LLM to return items for 'javascript' (a partial skill) and 'react' (evidence_probe).
    const llmMock = jest.fn().mockResolvedValue({
      parsedJson: {
        items: [
          {
            skill: 'javascript',
            question: 'LLM question about JS',
            good_answer_hints: ['hint1', 'hint2'],
          },
          { skill: 'react', question: 'LLM question about React', good_answer_hints: ['hint A'] },
        ],
      },
      rawResponse: '{"items":[...]}',
      tokenUsage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      latencyMs: 150,
      estimatedCostUsd: 0.005,
    });
    const { service, tracing } = build(llmMock);

    const result = await service.generatePlan('u1', {
      review,
      target_role: 'frontend_developer',
      lang: 'vi',
    });

    expect(result.llm_enhanced).toBe(true);
    expect(result.token_usage).toBe(300);
    expect(result.items.length).toBeGreaterThan(0);

    // Items whose canonical was returned by LLM carry the LLM question + hints
    const jsItem = result.items.find((i) => i.skill_canonical === 'javascript');
    if (jsItem) {
      expect(jsItem.question).toBe('LLM question about JS');
      expect(jsItem.good_answer_hints).toEqual(['hint1', 'hint2']);
    }
    const reactItem = result.items.find((i) => i.skill_canonical === 'react');
    if (reactItem) {
      expect(reactItem.question).toBe('LLM question about React');
    }

    // Tracing: saveAiResult + completeAiRequest both called
    expect(tracing.saveAiResult).toHaveBeenCalledTimes(1);
    expect(tracing.completeAiRequest).toHaveBeenCalledWith(
      'req-plan-1',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('drops hallucinated skills (not in plan) and falls back to template for unanswered areas', async () => {
    const review = makeReview();
    // LLM returns 'kubernetes' (hallucinated, NOT in frontend_developer plan) + misses some real areas
    const llmMock = jest.fn().mockResolvedValue({
      parsedJson: {
        items: [
          { skill: 'kubernetes', question: 'Tell me about kubernetes', good_answer_hints: [] },
        ],
      },
      rawResponse: '{}',
      tokenUsage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
      latencyMs: 80,
      estimatedCostUsd: 0.002,
    });
    const { service } = build(llmMock);

    const result = await service.generatePlan('u1', {
      review,
      target_role: 'frontend_developer',
      lang: 'vi',
    });

    // No item with canonical 'kubernetes'
    expect(result.items.every((i) => i.skill_canonical !== 'kubernetes')).toBe(true);

    // All items whose canonical was NOT returned by LLM must use the template_question
    for (const item of result.items) {
      expect(item.question).toBe(item.template_question);
      expect(item.good_answer_hints).toEqual([]);
    }
  });

  it('LLM throws → full template pack returned, llm_enhanced false, markFailed called', async () => {
    const review = makeReview();
    const llmMock = jest.fn().mockRejectedValue(new Error('LLM service unavailable'));
    const { service, tracing } = build(llmMock);

    const result = await service.generatePlan('u1', {
      review,
      target_role: 'frontend_developer',
      lang: 'vi',
    });

    expect(result.llm_enhanced).toBe(false);
    expect(result.token_usage).toBe(0);
    expect(result.items.length).toBeGreaterThan(0);

    // Every question is the deterministic template fallback
    for (const item of result.items) {
      expect(item.question).toBe(item.template_question);
      expect(item.good_answer_hints).toEqual([]);
    }

    // tracing.markFailed must have been called
    expect(tracing.markFailed).toHaveBeenCalledTimes(1);
    // completeAiRequest must NOT have been called (LLM never succeeded)
    expect(tracing.completeAiRequest).not.toHaveBeenCalled();
  });

  it('unknown role (no rubric) → throws INTERVIEW_PLAN_NO_RUBRIC', async () => {
    const review = makeReview();
    const { service } = build();

    await expect(
      service.generatePlan('u1', {
        review,
        target_role: 'astronaut',
        lang: 'vi',
      }),
    ).rejects.toThrow(/INTERVIEW_PLAN_NO_RUBRIC/);
  });
});
