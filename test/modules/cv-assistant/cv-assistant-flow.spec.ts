import { CvAssistantRewriteService } from '../../../src/modules/cv-assistant/cv-assistant.service';
import {
  cvBuilderAssistantTurn1,
  CompanionContext,
  CvAnswer,
} from '../../../src/modules/cv-assistant/cv-assistant';

// Build the Turn-2 service with a mocked LLM so the OPERATION (turn sequence + re-ask loop) is what's
// under test, not the model. llm.complete is asserted to NOT be called on a re-ask round.
function serviceWith(complete: jest.Mock): CvAssistantRewriteService {
  const llm = { complete } as never;
  const prompts = {
    get: jest.fn(() => ({ code: 'cv_assistant_rewrite_v1', version: 1, meta: { system: 'sys' } })),
    render: jest.fn(() => 'rendered'),
  } as never;
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('req-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  } as never;
  return new CvAssistantRewriteService(llm, prompts, tracing);
}

const llmReturns = (parsedJson: unknown): jest.Mock =>
  jest.fn().mockResolvedValue({
    parsedJson,
    text: '',
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    estimatedCostUsd: 0,
    latencyMs: 1,
    modelCode: 'gpt-test',
  });

const TARGET = 'projects[0].bullets[0]';

describe('CV Assistant — end-to-end OPERATION (multi-turn + re-ask loop)', () => {
  it('weak bullet → Turn-1 asks → bare answer RE-ASKS (no LLM, no patch) → detailed answer → grounded patch', async () => {
    const ctx: CompanionContext = {
      page: 'cv_builder',
      section: 'projects',
      current_value: 'Worked on the project.',
      locale: 'en',
    };

    // --- Turn 1: the assistant detects the gaps and asks, never fabricating a patch up front.
    const turn1 = cvBuilderAssistantTurn1(ctx);
    expect(turn1).not.toBeNull();
    expect(turn1!.questions.map((q) => q.gap)).toEqual(['action', 'tech', 'result']);
    expect(turn1!.questions.every((q) => q.allows_free_text)).toBe(true);
    expect(turn1!.field_patch).toBeNull();

    // --- Round 1: user answers, but the tech is a BARE category (no concrete tech) → must re-ask.
    const noLlm = jest.fn();
    const round1: CvAnswer[] = [
      { gap: 'action', option_id: 'built' },
      { gap: 'tech', option_id: 'backend' }, // no detail
      { gap: 'result', option_id: 'faster' },
    ];
    const r1 = await serviceWith(noLlm).rewrite({
      before: ctx.current_value!,
      answers: round1,
      target: TARGET,
      language: 'en',
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.reason).toBe('NEEDS_DETAIL');
      expect(r1.gap).toBe('tech');
    }
    expect(noLlm).not.toHaveBeenCalled(); // a re-ask costs no LLM call

    // --- Round 2: user supplies the concrete tech → the model rewrites from grounded facts → a patch.
    const complete = llmReturns({
      after: 'Built the backend with Node.js, making it faster.',
      used_facts: ['built', 'Node.js', 'faster'],
    });
    const round2: CvAnswer[] = [
      { gap: 'action', option_id: 'built' },
      { gap: 'tech', option_id: 'backend', detail: 'Node.js' },
      { gap: 'result', option_id: 'faster' },
    ];
    const r2 = await serviceWith(complete).rewrite({
      before: ctx.current_value!,
      answers: round2,
      target: TARGET,
      language: 'en',
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.field_patch.before).toBe('Worked on the project.');
      expect(r2.field_patch.after).toContain('Node.js');
      expect(r2.field_patch.target).toBe(TARGET);
      expect(r2.field_patch.why).toBeTruthy();
    }
  });

  it('a model that fabricates mid-flow is REJECTED — the operation re-asks instead of writing a bad patch', async () => {
    const complete = llmReturns({
      after: 'Built the backend with Node.js, cutting latency by 80%.', // 80% never given
      used_facts: ['built', 'Node.js'],
    });
    const r = await serviceWith(complete).rewrite({
      before: 'Worked on the project.',
      answers: [
        { gap: 'action', option_id: 'built' },
        { gap: 'tech', option_id: 'backend', detail: 'Node.js' },
      ],
      target: TARGET,
      language: 'en',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('UNGROUNDED');
  });

  it('a strong bullet → Turn-1 stays quiet (0 questions, positive message) — the assistant does not nag', () => {
    const turn = cvBuilderAssistantTurn1({
      page: 'cv_builder',
      section: 'projects',
      current_value: 'Built a checkout API with Node and Redis, cut p95 latency by 30%.',
      locale: 'en',
    });
    expect(turn).not.toBeNull();
    expect(turn!.questions).toHaveLength(0);
    expect(turn!.field_patch).toBeNull();
  });
});
