import { CvRewriteService } from '../../../src/modules/cv-builder/cv-rewrite.service';

/**
 * Unit tests with a MOCKED LLM — no network. Focus on the deterministic layers around the
 * call: validation, anti-fabrication guardrail, fallback, cache, output cleaning.
 */
describe('CvRewriteService (mocked LLM)', () => {
  const makePrompts = () => ({
    render: jest.fn().mockReturnValue('rendered'),
    get: jest.fn().mockReturnValue({ meta: { system: 'sys' } }),
  });
  const makeLlm = (text: string) => ({ complete: jest.fn().mockResolvedValue({ text }) });
  // Shared mutable mocks used by the tailor describe block
  let svc: CvRewriteService;
  let llm: { complete: jest.Mock };
  let prompts: ReturnType<typeof makePrompts>;

  const build = (llmText: string) => {
    const llm = makeLlm(llmText);
    const prompts = makePrompts();
    return { svc: new CvRewriteService(llm as never, prompts as never), llm };
  };

  it('rejects empty text', async () => {
    const { svc } = build('x');
    await expect(svc.rewrite({ text: '  ', mode: 'harvard' })).rejects.toThrow();
  });

  it('translate requires target_lang', async () => {
    const { svc } = build('x');
    await expect(svc.rewrite({ text: 'abc', mode: 'translate' })).rejects.toThrow();
  });

  it('custom requires instruction', async () => {
    const { svc } = build('x');
    await expect(svc.rewrite({ text: 'abc', mode: 'custom' })).rejects.toThrow();
  });

  it('GUARDRAIL: invented number → fallback to original', async () => {
    // input has no number; LLM hallucinates "40%"
    const { svc } = build('Optimized the build pipeline, cutting time by 40%.');
    const res = await svc.rewrite({ text: 'Worked on the build pipeline', mode: 'harvard' });
    expect(res.fallback).toBe(true);
    expect(res.suggestion).toBe('Worked on the build pipeline');
  });

  it('keeps suggestion when numbers match (format-insensitive)', async () => {
    const { svc } = build('Built a dashboard serving 5,000 users.');
    const res = await svc.rewrite({ text: 'made dashboard for 5000 users', mode: 'harvard' });
    expect(res.fallback).toBeFalsy(); // 5,000 == 5000
    expect(res.suggestion).toContain('5,000');
  });

  it('translate may keep all numbers (no fabrication check on translate)', async () => {
    const { svc } = build('Built API with Node.js, cut response time 30%.');
    const res = await svc.rewrite({
      text: 'Xây API Node.js, giảm 30% thời gian',
      mode: 'translate',
      target_lang: 'en',
    });
    expect(res.fallback).toBeFalsy();
  });

  it('cleans wrapping quotes and "Here is" preamble', async () => {
    const { svc } = build('"Led the migration to TypeScript."');
    const res = await svc.rewrite({ text: 'Did the TypeScript migration', mode: 'harvard' });
    expect(res.suggestion).toBe('Led the migration to TypeScript.');
  });

  it('emphasis idioms (24/7, 100%) do NOT trigger false fallback', async () => {
    const { svc } = build('Monitored production servers 24/7.');
    const res = await svc.rewrite({ text: 'monitored servers', mode: 'harvard' });
    expect(res.fallback).toBeFalsy();
    expect(res.suggestion).toContain('24/7');
  });

  it('GUARDRAIL: fabricated bare number alongside a dotted version is caught (no separator collision)', async () => {
    // input has "1.5.0" → digits ["150"]; output invents "150 users" → must be flagged
    const { svc } = build('Built version 1.5.0 of the parser, serving 150 users.');
    const res = await svc.rewrite({ text: 'Built version 1.5.0 of the parser', mode: 'harvard' });
    expect(res.fallback).toBe(true);
  });

  it('does NOT mangle a boundary-quoted product name', async () => {
    const { svc } = build('"QuickPay" launched to users');
    const res = await svc.rewrite({ text: 'launched QuickPay', mode: 'harvard' });
    expect(res.suggestion).toBe('"QuickPay" launched to users'); // balanced-wrap only, untouched
  });

  it('caches identical requests (one LLM call)', async () => {
    const { svc, llm } = build('Optimized the API.');
    const req = { text: 'made the api better', mode: 'harvard' as const };
    await svc.rewrite(req);
    await svc.rewrite(req);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // tailor mode
  // ---------------------------------------------------------------------------
  describe('tailor mode', () => {
    beforeEach(() => {
      llm = { complete: jest.fn() };
      prompts = makePrompts();
      svc = new CvRewriteService(llm as never, prompts as never);
    });

    it('tailor without tailor_action → BadRequest NO_TAILOR_ACTION', async () => {
      await expect(
        svc.rewrite({ text: 'built dashboards', mode: 'tailor' } as never),
      ).rejects.toMatchObject({ response: { code: 'NO_TAILOR_ACTION' } });
    });

    it('tailor emphasize: server-built instruction reaches the prompt; suggestion returned', async () => {
      llm.complete.mockResolvedValue({ text: 'Built React dashboards for ops teams' });
      const res = await svc.rewrite({
        text: 'built dashboards for ops teams',
        mode: 'tailor',
        tailor_action: { action_type: 'emphasize', skill_display: 'React' },
      } as never);
      expect(res.suggestion).toBe('Built React dashboards for ops teams');
      expect(res.fallback).toBeFalsy();
      const rendered = prompts.render.mock.calls.at(-1)![1] as Record<string, string>;
      expect(rendered.instruction).toContain('"React"');
      expect(rendered.instruction).toContain('VERIFIED');
      expect(rendered.mode).toBe('tailor');
    });

    it('tailor still trips the invented-number guard (falls back to original)', async () => {
      llm.complete.mockResolvedValue({ text: 'Built React dashboards improving latency 37%' });
      const res = await svc.rewrite({
        text: 'built dashboards',
        mode: 'tailor',
        tailor_action: { action_type: 'emphasize', skill_display: 'React' },
      } as never);
      expect(res.fallback).toBe(true);
      expect(res.suggestion).toBe('built dashboards');
    });

    it('different tailor_actions on the same text are cached separately (two LLM calls)', async () => {
      llm.complete.mockResolvedValue({ text: 'ok output' });
      const base = { text: 'built dashboards', mode: 'tailor' } as const;
      await svc.rewrite({
        ...base,
        tailor_action: { action_type: 'emphasize', skill_display: 'React' },
      } as never);
      await svc.rewrite({
        ...base,
        tailor_action: { action_type: 'emphasize', skill_display: 'Docker' },
      } as never);
      expect(llm.complete).toHaveBeenCalledTimes(2);
    });
  });
});
