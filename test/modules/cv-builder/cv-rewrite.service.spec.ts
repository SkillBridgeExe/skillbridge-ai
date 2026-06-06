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
});
