import { buildChatParams } from '../../../src/infrastructure/llm/providers/openai.provider';

describe('buildChatParams (OpenAI param assembly)', () => {
  it('reasoning model (gpt-5.4-mini): no temperature, no seed, uses max_completion_tokens', () => {
    const p = buildChatParams('gpt-5.4-mini', { temperature: 0.1, maxOutputTokens: 3000, seed: 42 });
    expect('temperature' in p).toBe(false);
    expect('seed' in p).toBe(false);
    expect(p.max_completion_tokens as number).toBeGreaterThanOrEqual(8192);
  });

  it('non-reasoning model (gpt-4o-mini): sends temperature 0 + seed + max_tokens', () => {
    const p = buildChatParams('gpt-4o-mini', { temperature: 0, maxOutputTokens: 3000, seed: 42 });
    expect(p.temperature).toBe(0);
    expect(p.seed).toBe(42);
    expect(p.max_tokens).toBe(3000);
  });

  it('non-reasoning model without seed: seed omitted (prod-neutral)', () => {
    const p = buildChatParams('gpt-4o-mini', { temperature: 0.2 });
    expect('seed' in p).toBe(false);
    expect(p.temperature).toBe(0.2);
  });

  it('defaults: classic temperature 0.2 + max_tokens 2048 when unset', () => {
    const p = buildChatParams('gpt-4o-mini', {});
    expect(p.temperature).toBe(0.2);
    expect(p.max_tokens).toBe(2048);
  });
});
