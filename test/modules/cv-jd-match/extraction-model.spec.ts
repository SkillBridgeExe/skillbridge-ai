import { resolveExtractionModel } from '../../../src/modules/cv-jd-match/extraction-model';

describe('resolveExtractionModel (Phase 2 extraction-model toggle)', () => {
  it('toggle OFF (no override) → default model, temperature 0.1, no seed (byte-identical legacy)', () => {
    const r = resolveExtractionModel({ defaultModel: 'gpt-5.4-mini' });
    expect(r.model).toBe('gpt-5.4-mini');
    expect(r.temperature).toBe(0.1);
    expect('seed' in r).toBe(false);
  });

  it('empty / whitespace override → treated as OFF', () => {
    expect(resolveExtractionModel({ defaultModel: 'gpt-5.4-mini', overrideModel: '' }).model).toBe(
      'gpt-5.4-mini',
    );
    expect(
      resolveExtractionModel({ defaultModel: 'gpt-5.4-mini', overrideModel: '   ' }).model,
    ).toBe('gpt-5.4-mini');
  });

  it('toggle ON (override set) → override model, temperature 0, seed passed through', () => {
    const r = resolveExtractionModel({
      defaultModel: 'gpt-5.4-mini',
      overrideModel: 'gpt-4o-mini',
      seed: 7,
    });
    expect(r.model).toBe('gpt-4o-mini');
    expect(r.temperature).toBe(0);
    expect(r.seed).toBe(7);
  });

  it('toggle ON without seed → override model, temp 0, no seed', () => {
    const r = resolveExtractionModel({
      defaultModel: 'gpt-5.4-mini',
      overrideModel: 'gpt-4o-mini',
    });
    expect(r.model).toBe('gpt-4o-mini');
    expect(r.temperature).toBe(0);
    expect('seed' in r).toBe(false);
  });
});
