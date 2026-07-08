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

  it('passes the softer-tone instruction to render vars when tone=softer', async () => {
    const complete = llmOk({
      after: 'Helped build the feature with Node.js.',
      used_facts: ['built', 'Node.js'],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    await svc.rewrite({
      before: 'Worked on it.',
      answers: ANSWERS_OK,
      target: 'projects[0].bullets[0]',
      language: 'en',
      tone: 'softer',
    });
    const prompts = d.prompts as unknown as { render: jest.Mock };
    expect(prompts.render).toHaveBeenCalledWith(
      'cv_assistant_rewrite_v1',
      expect.objectContaining({
        tone_instruction: expect.stringContaining('lighter, more modest tone'),
      }),
    );
  });

  it('defaults tone_instruction to a neutral placeholder when no tone is given (render vars stable)', async () => {
    const complete = llmOk({
      after: 'Built the feature with Node.js.',
      used_facts: ['built', 'Node.js'],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    await svc.rewrite({
      before: 'Worked on it.',
      answers: ANSWERS_OK,
      target: 'projects[0].bullets[0]',
      language: 'en',
    });
    const prompts = d.prompts as unknown as { render: jest.Mock };
    expect(prompts.render).toHaveBeenCalledWith(
      'cv_assistant_rewrite_v1',
      expect.objectContaining({ language: 'en', tone_instruction: '(default)' }),
    );
  });

  it('still rejects a fabricated fact when tone=softer (grounding unchanged)', async () => {
    const complete = llmOk({
      after: 'Helped build with Node.js, cut latency by 50%.',
      used_facts: ['built', 'Node.js'],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    const out = await svc.rewrite({
      before: 'Worked on it.',
      answers: ANSWERS_OK,
      target: 'projects[0].bullets[0]',
      language: 'en',
      tone: 'softer',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('UNGROUNDED');
  });

  it('renders the prompt in output_lang while messages stay in locale (output_lang parity)', async () => {
    const complete = llmOk({
      after: 'Xây tính năng bằng Node.js.',
      used_facts: ['built', 'Node.js'],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    // UI locale = en, CV output_lang = vi → the rewritten text must be generated in vi.
    await svc.rewrite({
      before: 'Worked on it.',
      answers: ANSWERS_OK,
      target: 'projects[0].bullets[0]',
      language: 'en',
      outputLang: 'vi',
    });
    const prompts = d.prompts as unknown as { render: jest.Mock };
    expect(prompts.render).toHaveBeenCalledWith(
      'cv_assistant_rewrite_v1',
      expect.objectContaining({ language: 'vi' }),
    );
  });

  it('transform intent can rewrite from the original bullet without fake answer gaps', async () => {
    const complete = llmOk({
      after: 'Built the checkout API with Node.js and reduced p95 latency by 30%.',
      used_facts: [],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    const out = await svc.rewrite({
      before: 'Built checkout API with Node.js, reduced p95 latency by 30%.',
      answers: [],
      target: 'projects[0].bullets[0]',
      language: 'en',
      intent: 'improve',
    });

    expect(out.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    const prompts = d.prompts as unknown as { render: jest.Mock };
    expect(prompts.render).toHaveBeenCalledWith(
      'cv_assistant_rewrite_v1',
      expect.objectContaining({
        intent_instruction: expect.stringMatching(/polish/i),
      }),
    );
  });

  it('add-evidence intent re-asks for result/evidence before spending LLM when the bullet has none', async () => {
    const complete = jest.fn();
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    const out = await svc.rewrite({
      before: 'Built a small dashboard with React.',
      answers: [],
      target: 'projects[0].bullets[0]',
      language: 'en',
      intent: 'add_evidence',
    });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('NEEDS_DETAIL');
      expect(out.gap).toBe('result');
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it('make-ATS-friendly intent is a safe transform, not a gap-question detour', async () => {
    const complete = llmOk({
      after: 'Built React dashboard components for the checkout flow.',
      used_facts: [],
    });
    const d = makeDeps(complete);
    const svc = new CvAssistantRewriteService(d.llm, d.prompts, d.tracing);
    const out = await svc.rewrite({
      before: 'Built React dashboard components for checkout.',
      answers: [],
      target: 'projects[0].bullets[0]',
      language: 'en',
      intent: 'make_ats_friendly',
    });

    expect(out.ok).toBe(true);
    const prompts = d.prompts as unknown as { render: jest.Mock };
    expect(prompts.render).toHaveBeenCalledWith(
      'cv_assistant_rewrite_v1',
      expect.objectContaining({
        intent_instruction: expect.stringContaining('ATS'),
      }),
    );
  });
});
