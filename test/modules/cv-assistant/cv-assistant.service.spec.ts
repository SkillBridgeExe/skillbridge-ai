import { CvAssistantRewriteService } from '../../../src/modules/cv-assistant/cv-assistant.service';
import { CvAnswer } from '../../../src/modules/cv-assistant/cv-assistant';

function makeDeps(complete: jest.Mock) {
  const llm = { complete } as never;
  const prompts = {
    get: jest.fn(() => ({ code: 'cv_assistant_rewrite_v1', version: 1, meta: { system: 'sys' } })),
    render: jest.fn(() => 'rendered user prompt'),
  } as never;
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('req-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  } as never;
  return { llm, prompts, tracing };
}

const llmOk = (parsedJson: unknown): jest.Mock =>
  jest.fn().mockResolvedValue({
    parsedJson,
    text: '',
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    estimatedCostUsd: 0,
    latencyMs: 1,
    modelCode: 'gpt-test',
  });

const ANSWERS_OK: CvAnswer[] = [
  { gap: 'action', option_id: 'built' },
  { gap: 'tech', option_id: 'backend', detail: 'Node.js' },
];

describe('CvAssistantRewriteService.rewrite', () => {
  it('re-asks WITHOUT calling the LLM when a tech category has no concrete detail', async () => {
    const complete = jest.fn();
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    const out = await svc.rewrite({
      before: 'Worked on it.',
      answers: [{ gap: 'tech', option_id: 'backend' }],
      target: 'projects[0].bullets[0]',
      language: 'en',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('NEEDS_DETAIL');
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns a field_patch when the model rewrite uses ONLY grounded facts', async () => {
    const complete = llmOk({
      after: 'Built the feature with Node.js.',
      used_facts: ['built', 'Node.js'],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    const out = await svc.rewrite({
      before: 'Worked on it.',
      answers: ANSWERS_OK,
      target: 'projects[0].bullets[0]',
      language: 'en',
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.field_patch.after).toContain('Node.js');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit a patch when the model fabricates a number', async () => {
    const complete = llmOk({
      after: 'Built with Node.js, cut latency by 50%.',
      used_facts: ['built', 'Node.js'],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    const out = await svc.rewrite({
      before: 'Worked on it.',
      answers: ANSWERS_OK,
      target: 'projects[0].bullets[0]',
      language: 'en',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('UNGROUNDED');
  });

  it('degrades (never throws) when the LLM call fails', async () => {
    const complete = jest.fn().mockRejectedValue(new Error('llm down'));
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    const out = await svc.rewrite({
      before: 'Worked on it.',
      answers: ANSWERS_OK,
      target: 'projects[0].bullets[0]',
      language: 'vi',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('DEGRADED');
  });

  it('selects the summary prompt when kind=summary', async () => {
    const complete = llmOk({
      after: 'Backend Developer skilled in Node.js.',
      used_facts: ['Node.js'],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    await svc.rewrite({
      before: 'Looking for a job.',
      answers: [{ gap: 'strength', option_id: 'backend', detail: 'Node.js' }],
      target: 'summary',
      language: 'en',
      kind: 'summary',
    });
    const prompts = d.prompts as unknown as { get: jest.Mock; render: jest.Mock };
    expect(prompts.get).toHaveBeenCalledWith('cv_summary_rewrite_v1');
    expect(prompts.render).toHaveBeenCalledWith('cv_summary_rewrite_v1', expect.anything());
  });
});
