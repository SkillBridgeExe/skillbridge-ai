import { TrendsInsightService } from '../../../src/modules/jobs/trends/trends-insight.service';

type TrendsInsightDeps = ConstructorParameters<typeof TrendsInsightService>;

function deps() {
  const demand = {
    getTrends: jest.fn().mockResolvedValue({
      role_code: 'backend_developer',
      period: '2026-06-07',
      total_active_jobs: 200,
      sample_size: 200,
      data_confidence: 'high',
      skills: [
        {
          canonical_name: 'security',
          display_name: 'Security',
          posting_count: 78,
          pct_of_postings: 39.3,
          salary_p50_vnd: 28000000,
          trend_delta: 2,
        },
      ],
    }),
    getSkillGap: jest.fn(),
    getCoOccurrence: jest.fn().mockResolvedValue([]),
  };
  const llm = {
    complete: jest.fn().mockResolvedValue({
      text: '{}',
      parsedJson: {
        summary: 'Security hot.',
        insights: [{ skill: 'security', comment: 'ưu tiên' }],
        recommended_skills: ['security'],
      },
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      modelCode: 'gpt-x',
      provider: 'openai',
      latencyMs: 5,
      estimatedCostUsd: 0.0001,
    }),
  };
  const prompts = {
    get: jest
      .fn()
      .mockReturnValue({ code: 'trends_insight', version: 1, body: '', meta: { system: 'sys' } }),
    render: jest.fn().mockReturnValue('user'),
  };
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('req-1'),
    saveAiResult: jest.fn().mockResolvedValue('res-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const db = { query: jest.fn() };
  const svc = new TrendsInsightService(
    demand as unknown as TrendsInsightDeps[0],
    llm as unknown as TrendsInsightDeps[1],
    prompts as unknown as TrendsInsightDeps[2],
    tracing as unknown as TrendsInsightDeps[3],
    db as unknown as TrendsInsightDeps[4],
  );
  return { svc, demand, llm, prompts, tracing, db };
}

describe('TrendsInsightService', () => {
  it('cache MISS: calls LLM, grounds, writes cache', async () => {
    const { svc, llm, db } = deps();
    db.query.mockResolvedValueOnce([]); // readCache → miss
    db.query.mockResolvedValueOnce([]); // writeCache
    const out = await svc.generate({ role_code: 'backend_developer', user_id: 'u1' });
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(out.insights[0].skill).toBe('security');
    expect(out.insights[0].pct_of_postings).toBe(39.3);
    expect(out.cached).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('cache HIT: serves cached payload, NO LLM call', async () => {
    const { svc, llm, db } = deps();
    db.query.mockResolvedValueOnce([
      {
        payload: {
          role_code: 'backend_developer',
          period: '2026-06-07',
          personalized: false,
          summary: 's',
          insights: [],
          recommended_skills: [],
          cached: false,
        },
      },
    ]);
    const out = await svc.generate({ role_code: 'backend_developer', user_id: 'u1' });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(out.cached).toBe(true);
  });

  it('LLM throws: marks trace FAILED, returns deterministic fallback (no 500)', async () => {
    const { svc, llm, db, tracing } = deps();
    db.query.mockResolvedValueOnce([]); // readCache → miss
    llm.complete.mockRejectedValueOnce(new Error('LLM down'));
    const out = await svc.generate({ role_code: 'backend_developer', user_id: 'u1' });
    expect(tracing.markFailed).toHaveBeenCalled();
    expect(out.insights[0].skill).toBe('security');
    expect(out.insights[0].comment).toBe('');
  });

  it('thin pool: surfaces data_confidence=low + sample_size, and feeds both into the prompt FACTS', async () => {
    const { svc, demand, prompts, db } = deps();
    demand.getTrends.mockResolvedValue({
      role_code: 'ai_app_engineer',
      period: '2026-06-16',
      total_active_jobs: 8,
      sample_size: 8,
      data_confidence: 'low',
      skills: [],
    });
    db.query.mockResolvedValueOnce([]); // readCache → miss
    db.query.mockResolvedValueOnce([]); // writeCache
    const out = await svc.generate({ role_code: 'ai_app_engineer', user_id: 'u1' });
    expect(out.sample_size).toBe(8);
    expect(out.data_confidence).toBe('low');
    // FACTS (the single source) fed to the prompt carry the signal so the LLM can hedge:
    const factsArg = (prompts.render as jest.Mock).mock.calls[0][1].facts as string;
    expect(factsArg).toContain('"data_confidence": "low"');
    expect(factsArg).toContain('"sample_size": 8');
  });
});
