import { CvRewriteService } from '../../../src/modules/cv-builder/cv-rewrite.service';

/**
 * Unit tests with a MOCKED LLM — no network. Focus on the deterministic layers around the
 * call: validation, anti-fabrication guardrail, fallback, cache, output cleaning, tracing.
 */
describe('CvRewriteService (mocked LLM)', () => {
  const makePrompts = () => ({
    render: jest.fn().mockReturnValue('rendered'),
    get: jest.fn().mockReturnValue({ code: 'cv_rewrite_v1', version: 1, meta: { system: 'sys' } }),
  });

  const makeLlmResult = (text: string) => ({
    text,
    tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    estimatedCostUsd: 0.0001,
    latencyMs: 5,
  });

  const makeTracing = () => ({
    startAiRequest: jest.fn().mockResolvedValue('req-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  });

  const makeLlm = (text: string) => ({
    complete: jest.fn().mockResolvedValue(makeLlmResult(text)),
  });

  // Shared mutable mocks used by the tailor describe block
  let svc: CvRewriteService;
  let llm: { complete: jest.Mock };
  let prompts: ReturnType<typeof makePrompts>;

  const build = (llmText: string) => {
    const llm = makeLlm(llmText);
    const prompts = makePrompts();
    const tracing = makeTracing();
    return {
      svc: new CvRewriteService(llm as never, prompts as never, tracing as never),
      llm,
      tracing,
    };
  };

  it('rejects empty text', async () => {
    const { svc } = build('x');
    await expect(svc.rewrite({ text: '  ', mode: 'harvard' })).rejects.toThrow();
  });

  describe('ON-TOPIC guard (prompt sentinel)', () => {
    it('maps the OFF_TOPIC sentinel to a 400, completes the trace as SUCCESS, never markFailed, never caches', async () => {
      const { svc, llm, tracing } = build('OFF_TOPIC');
      const req = {
        text: 'hôm nay trời đẹp quá nên mình đi chơi công viên',
        mode: 'harvard',
      } as never;
      await expect(svc.rewrite(req)).rejects.toMatchObject({
        response: { code: 'OFF_TOPIC' },
      });
      // The LLM call really happened and cost money → SUCCESS trace, not FAILED.
      expect(tracing.completeAiRequest).toHaveBeenCalledTimes(1);
      expect(tracing.markFailed).not.toHaveBeenCalled();
      // Not cached: a second identical call hits the LLM again (verdicts are not RewriteResponses).
      await expect(svc.rewrite(req)).rejects.toMatchObject({
        response: { code: 'OFF_TOPIC' },
      });
      expect(llm.complete).toHaveBeenCalledTimes(2);
    });

    it('tolerates sentinel formatting variants (off-topic. / OFF TOPIC)', async () => {
      const { svc } = build('off-topic.');
      await expect(
        svc.rewrite({
          text: 'bài hát này hay quá mọi người cùng nghe nhé',
          mode: 'harvard',
        } as never),
      ).rejects.toMatchObject({ response: { code: 'OFF_TOPIC' } });
    });
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
    const res = await svc.rewrite({
      text: 'monitored on-call production servers',
      mode: 'harvard',
    });
    expect(res.fallback).toBeFalsy();
    expect(res.suggestion).toContain('24/7');
  });

  it('GUARDRAIL: fabricated bare number alongside a dotted version is caught (no separator collision)', async () => {
    // input has "1.5.0" → digits ["1.5.0"]; output invents "150 users" → must be flagged
    const { svc } = build('Built version 1.5.0 of the parser, serving 150 users.');
    const res = await svc.rewrite({ text: 'Built version 1.5.0 of the parser', mode: 'harvard' });
    expect(res.fallback).toBe(true);
  });

  it('does NOT mangle a boundary-quoted product name', async () => {
    const { svc } = build('"QuickPay" launched to users');
    const res = await svc.rewrite({
      text: 'launched QuickPay product for consumers',
      mode: 'harvard',
    });
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
  // regenerate: an explicit "Viết lại / Tạo lại" must produce a FRESH suggestion,
  // not the cached identical sentence (user-reported bug). The variant token is the
  // only thing that changes the cache identity; an accidental double-click with the
  // SAME variant must still hit the cache (cost protection).
  // ---------------------------------------------------------------------------
  describe('regenerate via variant token', () => {
    it('same input, different variant → cache miss → a second LLM call', async () => {
      const { svc, llm } = build('Optimized the API.');
      const base = { text: 'made the api better', mode: 'harvard' as const };
      await svc.rewrite(base); // first take (no variant) — cacheable
      await svc.rewrite({ ...base, variant: '1' }); // explicit regenerate
      expect(llm.complete).toHaveBeenCalledTimes(2);
    });

    it('same variant repeated → cache hit (one call) — protects against double-click', async () => {
      const { svc, llm } = build('Optimized the API.');
      const req = { text: 'made the api better', mode: 'harvard' as const, variant: '2' };
      await svc.rewrite(req);
      await svc.rewrite(req);
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });

    it('a regenerate samples at a HIGHER temperature than the first take (perceptible variation)', async () => {
      const { svc, llm } = build('Optimized the API.');
      await svc.rewrite({ text: 'made the api better', mode: 'harvard' });
      await svc.rewrite({ text: 'made the api better', mode: 'harvard', variant: '1' });
      const firstTemp = (llm.complete.mock.calls[0][1] as { temperature: number }).temperature;
      const regenTemp = (llm.complete.mock.calls[1][1] as { temperature: number }).temperature;
      expect(regenTemp).toBeGreaterThan(firstTemp);
    });
  });

  // ---------------------------------------------------------------------------
  // tracing tests
  // ---------------------------------------------------------------------------
  describe('tracing', () => {
    it('cache miss → startAiRequest called with requestType "cv_rewrite"', async () => {
      const { svc, tracing } = build('Improved the system.');
      await svc.rewrite({ text: 'worked on the system', mode: 'harvard' });
      expect(tracing.startAiRequest).toHaveBeenCalledTimes(1);
      expect(tracing.startAiRequest).toHaveBeenCalledWith(
        expect.objectContaining({ requestType: 'cv_rewrite' }),
      );
    });

    it('cache miss → completeAiRequest called with totalTokens from LLM result', async () => {
      const { svc, tracing } = build('Led the backend project.');
      await svc.rewrite({ text: 'managed the backend project deliverables', mode: 'harvard' });
      expect(tracing.completeAiRequest).toHaveBeenCalledTimes(1);
      expect(tracing.completeAiRequest).toHaveBeenCalledWith(
        'req-1',
        expect.objectContaining({ totalTokens: 30, status: 'SUCCESS' }),
      );
    });

    it('requestPayload does NOT contain the raw CV text string', async () => {
      const inputText = 'Developed a real-time analytics pipeline';
      const { svc, tracing } = build('Engineered a real-time analytics pipeline.');
      await svc.rewrite({ text: inputText, mode: 'harvard' });
      const callArg = tracing.startAiRequest.mock.calls[0][0] as Record<string, unknown>;
      const payload = JSON.stringify(callArg.requestPayload);
      expect(payload).not.toContain(inputText);
    });

    it('cache hit → startAiRequest called exactly ONCE across two identical calls', async () => {
      const { svc, tracing } = build('Optimized the API.');
      const req = { text: 'improved the api for mobile clients', mode: 'harvard' as const };
      await svc.rewrite(req);
      await svc.rewrite(req); // cache hit
      expect(tracing.startAiRequest).toHaveBeenCalledTimes(1);
    });

    it('llm.complete rejects → markFailed called once and error propagates', async () => {
      const llm = { complete: jest.fn().mockRejectedValue(new Error('LLM timeout')) };
      const prompts = makePrompts();
      const tracing = makeTracing();
      const svc = new CvRewriteService(llm as never, prompts as never, tracing as never);
      await expect(
        svc.rewrite({ text: 'did important infrastructure things here', mode: 'harvard' }),
      ).rejects.toThrow('LLM timeout');
      expect(tracing.markFailed).toHaveBeenCalledTimes(1);
    });

    it('userId=null is accepted (anonymous call, platform path)', async () => {
      const { svc, tracing } = build('Result.');
      await svc.rewrite({ text: 'some meaningful technical text here', mode: 'harvard' }, null);
      expect(tracing.startAiRequest).toHaveBeenCalledTimes(1);
    });

    it('userId passed through to startAiRequest', async () => {
      const { svc, tracing } = build('Result.');
      await svc.rewrite(
        { text: 'some meaningful technical text here', mode: 'harvard' },
        'user-abc',
      );
      expect(tracing.startAiRequest).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-abc' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // number-guard decimal-reformat fix (P2)
  // ---------------------------------------------------------------------------
  describe('number-guard: decimal reformat false-positive fix', () => {
    it('3.500 is treated as equivalent to 3.5 (trailing zero reformat allowed)', async () => {
      // input: "3.5 seconds", output: "3.500 seconds" — same value, no fabrication
      const { svc } = build('Improved latency by 3.500 seconds');
      const res = await svc.rewrite({
        text: 'improved latency by 3.5 seconds',
        mode: 'harvard',
      });
      expect(res.fallback).toBeFalsy();
    });

    it('100.0 is treated as equivalent to 100 (trailing zero after decimal allowed)', async () => {
      const { svc } = build('Reduced errors by 100.0 percent');
      const res = await svc.rewrite({ text: 'reduced errors by 100 percent', mode: 'harvard' });
      expect(res.fallback).toBeFalsy();
    });

    it('invented number 3.141 (no trailing zeros) is still caught', async () => {
      // input has no 3.141; output invents it → must fallback
      const { svc } = build('Achieved a score of 3.141');
      const res = await svc.rewrite({
        text: 'achieved an excellent performance score',
        mode: 'harvard',
      });
      expect(res.fallback).toBe(true);
    });

    it('existing test: invented % still causes fallback', async () => {
      const { svc } = build('Optimized the build pipeline, cutting time by 40%.');
      const res = await svc.rewrite({ text: 'Worked on the build pipeline', mode: 'harvard' });
      expect(res.fallback).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // input-quality gate (Change 1 — garbage must not reach the LLM or burn quota)
  // ---------------------------------------------------------------------------
  describe('input-quality gate', () => {
    it('"aa" (harvard) → rejects with code INSUFFICIENT_CONTEXT and llm.complete is NEVER called', async () => {
      const { svc, llm } = build('x');
      await expect(svc.rewrite({ text: 'aa', mode: 'harvard' })).rejects.toMatchObject({
        response: { code: 'INSUFFICIENT_CONTEXT' },
      });
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('"aa" (translate) → rejects with INSUFFICIENT_CONTEXT before LLM', async () => {
      const { svc, llm } = build('x');
      await expect(
        svc.rewrite({ text: 'aa', mode: 'translate', target_lang: 'en' }),
      ).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_CONTEXT' } });
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('"aa" (custom) → rejects with INSUFFICIENT_CONTEXT before LLM', async () => {
      const { svc, llm } = build('x');
      await expect(
        svc.rewrite({ text: 'aa', mode: 'custom', instruction: 'improve it' }),
      ).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_CONTEXT' } });
      expect(llm.complete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // tailor mode
  // ---------------------------------------------------------------------------
  describe('tailor mode', () => {
    beforeEach(() => {
      llm = { complete: jest.fn() };
      prompts = makePrompts();
      svc = new CvRewriteService(llm as never, prompts as never, makeTracing() as never);
    });

    it('tailor without tailor_action → BadRequest NO_TAILOR_ACTION', async () => {
      await expect(
        svc.rewrite({ text: 'built dashboards for internal ops teams', mode: 'tailor' } as never),
      ).rejects.toMatchObject({ response: { code: 'NO_TAILOR_ACTION' } });
    });

    it('tailor emphasize: server-built instruction reaches the prompt; suggestion returned', async () => {
      llm.complete.mockResolvedValue(makeLlmResult('Built React dashboards for ops teams'));
      const res = await svc.rewrite({
        text: 'built dashboards for internal ops teams',
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
      llm.complete.mockResolvedValue(makeLlmResult('Built React dashboards improving latency 37%'));
      const res = await svc.rewrite({
        text: 'built dashboards for internal ops teams',
        mode: 'tailor',
        tailor_action: { action_type: 'emphasize', skill_display: 'React' },
      } as never);
      expect(res.fallback).toBe(true);
      expect(res.suggestion).toBe('built dashboards for internal ops teams');
    });

    it('different tailor_actions on the same text are cached separately (two LLM calls)', async () => {
      llm.complete.mockResolvedValue(makeLlmResult('ok output'));
      const base = { text: 'built dashboards for internal ops teams', mode: 'tailor' } as const;
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
