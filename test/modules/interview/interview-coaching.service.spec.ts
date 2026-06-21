import { InterviewCoachingService } from '../../../src/modules/interview/interview-coaching.service';
import { InterviewScore } from '../../../src/modules/interview/interview-scoring';
import { InterviewGapItem } from '../../../src/modules/interview/interview-gap';
import { UnifiedDevelopmentPlan } from '../../../src/modules/gap-report/unified-plan';

const SCORE: InterviewScore = {
  overall: 72,
  overall_band: 'solid',
  role_family: 'ic_eng',
  scored_answers: 5,
  dimensions: [
    { dimension: 'technical_depth', score: 85, band: 'outstanding', weight: 40 },
    { dimension: 'evidence_credibility', score: 35, band: 'poor', weight: 15 },
  ],
};

const GAPS: InterviewGapItem[] = [
  {
    requirement_id: null,
    target_type: 'evidence',
    skill_canonical: 'react',
    display_name: 'React',
    weakness_type: 'evidence_gap',
    severity: 0.8,
    evidence_from_answer: 'no concrete example',
    recommended_action: 'Add a concrete React example.',
    linked_question_id: 'q1',
  },
];

const PLAN: UnifiedDevelopmentPlan = {
  match_id: 'm1',
  session_id: 's1',
  learn_items: [],
  cv_fix_items: [
    {
      source: 'interview',
      track: 'cv_fix',
      skill_canonical: 'react',
      display_name: 'React',
      priority: 0.8,
      severity: 0.8,
      rationale: 'Add a concrete React example.',
      weakness_type: 'evidence_gap',
    },
  ],
  interview_practice_items: [],
};

function build(
  llmImpl: jest.Mock = jest.fn().mockResolvedValue({
    rawResponse: { text: '{}' },
    text: '{}',
    parsedJson: {
      summary: 'Your technical depth was outstanding. Add one concrete React example next.',
      priority_notes: ['Production React roles want evidence you have shipped React.'],
    },
    tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    estimatedCostUsd: 0.001,
    modelCode: 'gpt-4o-mini',
    latencyMs: 50,
  }),
) {
  const llm = { complete: llmImpl };
  const prompts = {
    get: jest.fn().mockReturnValue({
      code: 'interview_coaching',
      version: 1,
      meta: { system: 'coach system' },
    }),
    render: jest.fn((_code: string, vars: Record<string, unknown>) => JSON.stringify(vars)),
  };
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('ai-request-1'),
    saveAiResult: jest.fn().mockResolvedValue('ai-result-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new InterviewCoachingService(llm as never, prompts as never, tracing as never),
    llm,
    prompts,
    tracing,
  };
}

describe('InterviewCoachingService.coach — happy path', () => {
  it('returns a grounded coaching from a valid LLM output', async () => {
    const { service } = build();
    const out = await service.coach({ score: SCORE, gaps: GAPS, plan: PLAN, language: 'en' });
    expect(out.summary).toContain('React');
    // strengths are CODE-derived from the score dimensions (solid+).
    expect(out.strengths).toEqual(['technical_depth: outstanding']);
    // priorities are CODE-owned (track + title from the plan).
    expect(out.priorities).toHaveLength(1);
    expect(out.priorities[0]).toMatchObject({ track: 'cv_fix', title: 'React' });
    expect(out.priorities[0].why).toContain('React');
  });

  it('passes schema-enforced temp-0 jsonMode options to the LLM', async () => {
    const { service, llm } = build();
    await service.coach({ score: SCORE, gaps: GAPS, plan: PLAN, language: 'en' });
    const opts = llm.complete.mock.calls[0][1];
    expect(opts).toMatchObject({
      provider: 'openai',
      jsonMode: true,
      temperature: 0,
      maxOutputTokens: 400,
    });
    expect(opts.responseSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('IGNORES a model that tries to fabricate a priority — output matches plan facts', async () => {
    const { service } = build(
      jest.fn().mockResolvedValue({
        rawResponse: { text: '{}' },
        text: '{}',
        parsedJson: {
          summary: 'ok',
          priorities: [{ track: 'learn', title: 'FAKE', why: 'made up' }],
          strengths: ['Invented Rust mastery'],
          priority_notes: ['real why'],
        },
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        modelCode: 'gpt-4o-mini',
        latencyMs: 10,
      }),
    );
    const out = await service.coach({ score: SCORE, gaps: GAPS, plan: PLAN, language: 'en' });
    expect(out.priorities).toHaveLength(1);
    expect(out.priorities[0].title).toBe('React');
    expect(out.strengths).toEqual(['technical_depth: outstanding']);
  });
});

describe('InterviewCoachingService.coach — degrade never throws', () => {
  it('returns a templated fallback when the LLM throws', async () => {
    const { service } = build(jest.fn().mockRejectedValue(new Error('llm down')));
    const out = await service.coach({ score: SCORE, gaps: GAPS, plan: PLAN, language: 'en' });
    expect(out.summary.length).toBeGreaterThan(0);
    // code-owned strengths/priorities still present.
    expect(out.strengths).toEqual(['technical_depth: outstanding']);
    expect(out.priorities).toHaveLength(1);
    expect(out.priorities[0].why.trim().length).toBeGreaterThan(0);
  });

  it('returns a templated fallback when parsedJson is null (bad JSON)', async () => {
    const { service } = build(
      jest.fn().mockResolvedValue({
        rawResponse: { text: 'not json' },
        text: 'not json',
        parsedJson: null,
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        modelCode: 'gpt-4o-mini',
        latencyMs: 10,
      }),
    );
    const out = await service.coach({ score: SCORE, gaps: GAPS, plan: PLAN, language: 'en' });
    expect(out.summary.length).toBeGreaterThan(0);
    expect(out.priorities[0].title).toBe('React');
  });

  it('never throws even when tracing itself rejects', async () => {
    const { service, tracing } = build();
    tracing.startAiRequest.mockRejectedValue(new Error('db down'));
    tracing.saveAiResult.mockRejectedValue(new Error('db down'));
    tracing.completeAiRequest.mockRejectedValue(new Error('db down'));
    await expect(
      service.coach({ score: SCORE, gaps: GAPS, plan: PLAN, language: 'en' }),
    ).resolves.toBeDefined();
  });
});
