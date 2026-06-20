import { CurationService } from '../../../src/modules/resource-curation/curation.service';
import { CurationInput } from '../../../src/modules/resource-curation/curation-scoring';

const input: CurationInput = {
  title: 'Docker for Developers',
  provider: 'react.dev',
  description: 'Learn Docker',
  skills: ['docker'],
};

const allLevel = (n: number) => ({
  relevance: { rationale: 'r', level: n },
  authority: { rationale: 'r', level: n },
  currency: { rationale: 'r', level: n },
  accuracy: { rationale: 'r', level: n },
  purpose: { rationale: 'r', level: n },
});

function makeService(over: { parsedJson?: unknown; throws?: boolean }) {
  const llm = {
    complete: jest.fn(async () => {
      if (over.throws) throw new Error('provider 503');
      return {
        parsedJson:
          'parsedJson' in over
            ? over.parsedJson
            : { craap: allLevel(3), flags: [], description: 'clean summary' },
        text: '{...}',
        tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        modelCode: 'gpt-4o-mini',
        latencyMs: 120,
        estimatedCostUsd: 0.0001,
      };
    }),
  };
  const prompts = {
    get: jest.fn(() => ({ code: 'resource_curation', version: 1, meta: { system: 'SYS' } })),
    render: jest.fn(() => 'RENDERED'),
  };
  const tracing = {
    startAiRequest: jest.fn(async () => 'req-1'),
    saveAiResult: jest.fn(async () => 'res-1'),
    completeAiRequest: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
  };
  const svc = new CurationService(llm as never, prompts as never, tracing as never);
  return { svc, llm, prompts, tracing };
}

describe('CurationService.curate', () => {
  it('renders, calls the LLM at temp 0 + jsonMode, adapts levels → core decision, traces SUCCESS', async () => {
    const { svc, llm, tracing } = makeService({});
    const out = await svc.curate(input);

    const opts = (llm.complete.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts.temperature).toBe(0);
    expect(opts.jsonMode).toBe(true);
    expect(out.quality_score).toBe(100); // all levels 3 → all 1.0 → 100
    expect(out.validation_status).toBe('verified');
    expect(tracing.startAiRequest).toHaveBeenCalledTimes(1);
    expect(tracing.saveAiResult).toHaveBeenCalledTimes(1);
    expect(tracing.completeAiRequest).toHaveBeenCalledTimes(1);
  });

  it('maps low levels through the discretization adapter (level 1 → 1/3 → sub-threshold pending)', async () => {
    const { svc } = makeService({
      parsedJson: { craap: allLevel(1), flags: [], description: 'thin' },
    });
    const out = await svc.curate(input);
    expect(out.quality_score).toBeLessThan(60);
    expect(out.validation_status).toBe('pending');
  });

  it('a promotional flag from the model forces flagged regardless of levels', async () => {
    const { svc } = makeService({
      parsedJson: { craap: allLevel(3), flags: ['promotional'], description: 'buy now' },
    });
    const out = await svc.curate(input);
    expect(out.flags).toContain('promotional');
    expect(out.validation_status).toBe('flagged');
  });

  it('degrades to a safe pending fallback (never throws) when the LLM fails + marks the trace FAILED', async () => {
    const { svc, tracing } = makeService({ throws: true });
    const out = await svc.curate(input);
    expect(out.validation_status).toBe('pending'); // hasSkills → pending, never auto-verify on failure
    expect(out.quality_score).toBe(0);
    expect(tracing.markFailed).toHaveBeenCalledTimes(1);
    expect(tracing.completeAiRequest).not.toHaveBeenCalled();
  });

  it('bad/garbage model JSON (null parsed) → pending fallback', async () => {
    const { svc } = makeService({ parsedJson: null });
    const out = await svc.curate(input);
    expect(out.validation_status).toBe('pending');
  });

  it('T3 (unknown provider) at mid quality does NOT auto-verify — routeValidation gate forces pending', async () => {
    const { svc } = makeService({
      parsedJson: { craap: allLevel(2), flags: [], description: 'ok' },
    });
    const out = await svc.curate({ ...input, provider: 'some-unknown-blog' });
    expect(out.quality_score).toBeGreaterThanOrEqual(60); // the lenient core would verify this
    expect(out.validation_status).toBe('pending'); // but a T3 provider is gated to pending (safe-for-commerce)
  });

  it('a tracing failure (startAiRequest throws) does NOT break curation — degrade-never-throw', async () => {
    const { svc, tracing } = makeService({});
    tracing.startAiRequest.mockRejectedValueOnce(new Error('tracing DB down'));
    const out = await svc.curate(input); // react.dev (T1) + levels 3 → the LLM succeeds
    expect(out.validation_status).toBe('verified'); // tracing failure swallowed; real result still returned
    expect(out.quality_score).toBe(100);
    expect(tracing.saveAiResult).not.toHaveBeenCalled(); // no aiRequestId → skip the rest of tracing
  });
});
