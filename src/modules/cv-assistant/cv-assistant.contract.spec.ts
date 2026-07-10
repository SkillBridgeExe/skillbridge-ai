import { buildCvAssistantTurn, buildSummaryTurn } from './cv-assistant';
import { CvAssistantRewriteService } from './cv-assistant.service';

/**
 * P3.1 — BE response-contract lock for the CV Builder assistant.
 *
 * Locks the two declared unions the FE branches on:
 *   Turn-1 `CvAssistantTurn`  — message + questions[] + field_patch:null (never a patch).
 *   Turn-2 `CvAssistantRewriteResult` — ok:true+field_patch | ok:false+reason∈{NEEDS_DETAIL,UNGROUNDED,DEGRADED}.
 * Every chip intent is pinned to its correct flow (P3-4): transforms rewrite, fact-seeking
 * intents ask first, fabrication is rejected, LLM failure degrades — never an empty patch.
 */

describe('Turn-1 union (deterministic turns)', () => {
  it('weak bullet → questions with options + free text, and NEVER a field_patch', () => {
    const turn = buildCvAssistantTurn('Worked on the project.', 'en');
    expect(turn.field_patch).toBeNull();
    expect(turn.questions.map((q) => q.gap)).toEqual(['action', 'tech', 'result']);
    for (const q of turn.questions) {
      expect(q.prompt).toBeTruthy();
      expect(q.options.length).toBeGreaterThan(0);
      expect(q.allows_free_text).toBe(true);
    }
  });

  it('add_evidence on a bullet that already has a result → no questions (safe transform later)', () => {
    const turn = buildCvAssistantTurn(
      'Optimized queries and reduced latency by 30%.',
      'en',
      'add_evidence',
    );
    expect(turn.questions).toEqual([]);
    expect(turn.field_patch).toBeNull();
  });

  it('make_ats_friendly asks ONLY for the missing tech', () => {
    const turn = buildCvAssistantTurn(
      'Optimized queries and reduced latency by 30%.',
      'en',
      'make_ats_friendly',
    );
    expect(turn.questions.map((q) => q.gap)).toEqual(['tech']);
  });

  it('summary turn asks summary gaps (role/strength/evidence), bilingual', () => {
    for (const lang of ['en', 'vi'] as const) {
      const turn = buildSummaryTurn('I am a hard-working person.', lang);
      expect(turn.questions.map((q) => q.gap)).toEqual(['role', 'strength', 'evidence']);
      expect(turn.field_patch).toBeNull();
    }
  });
});

describe('Turn-2 union (CvAssistantRewriteService result modes)', () => {
  const llmOk = (after: string, used_facts: string[] = []) => ({
    parsedJson: { after, used_facts },
    tokenUsage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    estimatedCostUsd: 0,
    latencyMs: 5,
    modelCode: 'test-model',
  });

  function setup(complete: jest.Mock) {
    const prompts = {
      get: jest.fn().mockReturnValue({ code: 'cv_assistant_rewrite_v1', version: 1, meta: {} }),
      render: jest.fn().mockReturnValue('prompt'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CvAssistantRewriteService(
      { complete } as never,
      prompts as never,
      tracing as never,
    );
    return { service, complete };
  }

  const base = {
    before: 'Worked on the project.',
    target: 'experience[0].description',
    language: 'en' as const,
  };

  it.each(['improve', 'shorten', 'make_ats_friendly'] as const)(
    'transform intent %s with EMPTY answers rewrites (no fake answer gap)',
    async (intent) => {
      const { service, complete } = setup(
        jest.fn().mockResolvedValue(llmOk('Built the project feature.')),
      );
      const result = await service.rewrite({ ...base, answers: [], intent });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        ok: true,
        field_patch: expect.objectContaining({
          target: base.target,
          before: base.before,
          after: 'Built the project feature.',
          why: expect.any(String),
        }),
      });
    },
  );

  it.each(['add_evidence', 'turn_into_impact'] as const)(
    '%s with no result fact returns NEEDS_DETAIL(result) WITHOUT calling the LLM',
    async (intent) => {
      const { service, complete } = setup(jest.fn());
      const result = await service.rewrite({ ...base, answers: [], intent });
      expect(complete).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        reason: 'NEEDS_DETAIL',
        gap: 'result',
        message: expect.any(String),
      });
    },
  );

  it('a bare tech category (no concrete detail) re-asks without an LLM call', async () => {
    const { service, complete } = setup(jest.fn());
    const result = await service.rewrite({
      ...base,
      answers: [{ gap: 'tech', option_id: 'backend' }],
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'NEEDS_DETAIL', gap: 'tech' });
  });

  it('empty answers with NO intent re-asks generically (never an empty rewrite)', async () => {
    const { service, complete } = setup(jest.fn());
    const result = await service.rewrite({ ...base, answers: [] });
    expect(complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'NEEDS_DETAIL' });
  });

  it('a user_clarify free-text answer is a grounded fact (its numbers become allowed)', async () => {
    const { service, complete } = setup(
      jest
        .fn()
        .mockResolvedValue(
          llmOk('Improved the project, cutting response time by 30%.', [
            'cut response time by 30%',
          ]),
        ),
    );
    const result = await service.rewrite({
      ...base,
      answers: [{ gap: 'user_clarify', option_id: 'other', detail: 'cut response time by 30%' }],
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      field_patch: expect.objectContaining({
        after: 'Improved the project, cutting response time by 30%.',
      }),
    });
  });

  it('a fabricated number is rejected as UNGROUNDED, never a patch', async () => {
    const { service } = setup(jest.fn().mockResolvedValue(llmOk('Cut load time by 30%.')));
    const result = await service.rewrite({ ...base, answers: [], intent: 'shorten' });
    expect(result).toEqual({ ok: false, reason: 'UNGROUNDED', message: expect.any(String) });
  });

  it('a fabricated named tech is rejected as UNGROUNDED, never a patch', async () => {
    const { service } = setup(jest.fn().mockResolvedValue(llmOk('Built the project with Kafka.')));
    const result = await service.rewrite({ ...base, answers: [], intent: 'improve' });
    expect(result).toMatchObject({ ok: false, reason: 'UNGROUNDED' });
  });

  it('an LLM failure degrades safely (DEGRADED + human message), never throws', async () => {
    const { service } = setup(jest.fn().mockRejectedValue(new Error('llm down')));
    const result = await service.rewrite({ ...base, answers: [], intent: 'improve' });
    expect(result).toEqual({ ok: false, reason: 'DEGRADED', message: expect.any(String) });
  });

  it('summary kind uses the summary prompt and returns the same union', async () => {
    const complete = jest.fn().mockResolvedValue(llmOk('Backend developer with NestJS focus.'));
    const prompts = {
      get: jest.fn().mockReturnValue({ code: 'cv_summary_rewrite_v1', version: 1, meta: {} }),
      render: jest.fn().mockReturnValue('prompt'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CvAssistantRewriteService(
      { complete } as never,
      prompts as never,
      tracing as never,
    );
    const result = await service.rewrite({
      before: 'I am a hard-working person.',
      target: 'summary',
      language: 'en',
      kind: 'summary',
      answers: [{ gap: 'strength', option_id: 'other', detail: 'NestJS' }],
    });
    expect(prompts.get).toHaveBeenCalledWith('cv_summary_rewrite_v1');
    expect(result).toMatchObject({ ok: true });
  });
});
