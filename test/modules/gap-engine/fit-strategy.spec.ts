import { classifyFit, FitInput } from '../../../src/modules/gap-engine/fit-strategy';

const base = (over: Partial<FitInput> = {}): FitInput => ({
  score: 80,
  required_coverage: 0.9,
  seniority_verdict: 'fits',
  unmet_deal_breakers: [],
  ...over,
});

describe('classifyFit', () => {
  it('score just below 40 → not_recommended (LOW_SCORE), regardless of everything else', () => {
    const result = classifyFit(base({ score: 39.99 }));
    expect(result.verdict).toBe('not_recommended');
    expect(result.reasons).toContain('LOW_SCORE');
  });

  it('score exactly 40 → LOW_SCORE no longer fires; strong coverage + fits but score < 65 → stretch', () => {
    const result = classifyFit(
      base({ score: 40, required_coverage: 0.9, seniority_verdict: 'fits' }),
    );
    expect(result.reasons).not.toContain('LOW_SCORE');
    expect(result.verdict).toBe('stretch');
    expect(result.reasons).toEqual(expect.arrayContaining(['STRONG_COVERAGE', 'SENIORITY_FITS']));
  });

  it('score 64.99 with strong coverage + fits → still stretch (score not yet 65)', () => {
    const result = classifyFit(base({ score: 64.99 }));
    expect(result.verdict).toBe('stretch');
    expect(result.reasons).not.toContain('STRONG_SCORE');
  });

  it('score exactly 65 with strong coverage + fits → safe_apply', () => {
    const result = classifyFit(base({ score: 65 }));
    expect(result.verdict).toBe('safe_apply');
    expect(result.reasons).toEqual(['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_FITS']);
  });

  it('required_coverage null does not block safe_apply (treated as pass, no STRONG_COVERAGE reason)', () => {
    const result = classifyFit(
      base({ score: 70, required_coverage: null, seniority_verdict: 'unknown' }),
    );
    expect(result.verdict).toBe('safe_apply');
    expect(result.reasons).toEqual(['STRONG_SCORE']);
  });

  it('unmet deal breaker wins over an otherwise perfect score/coverage/seniority', () => {
    const result = classifyFit(
      base({ score: 95, required_coverage: 1, unmet_deal_breakers: ['English C1'] }),
    );
    expect(result.verdict).toBe('not_recommended');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'STRONG_SCORE',
        'STRONG_COVERAGE',
        'SENIORITY_FITS',
        'DEAL_BREAKER_UNMET',
      ]),
    );
  });

  it('job-rec severe_stretch=true forces not_recommended even with a strong score', () => {
    const result = classifyFit(
      base({ score: 80, seniority_verdict: 'stretch', severe_stretch: true }),
    );
    expect(result.verdict).toBe('not_recommended');
    expect(result.reasons).toEqual(expect.arrayContaining(['SEVERE_STRETCH', 'SENIORITY_STRETCH']));
  });

  it('job-rec over_qualified with |level_gap| >= 3 → not_recommended (SENIORITY_OVERQUALIFIED)', () => {
    const result = classifyFit(
      base({ score: 90, required_coverage: 1, seniority_verdict: 'over_qualified', level_gap: -3 }),
    );
    expect(result.verdict).toBe('not_recommended');
    expect(result.reasons).toContain('SENIORITY_OVERQUALIFIED');
  });

  it('over_qualified with a mild |level_gap| < 3 does NOT trigger the severe rule, but still is not safe_apply', () => {
    const result = classifyFit(
      base({ score: 90, required_coverage: 1, seniority_verdict: 'over_qualified', level_gap: -1 }),
    );
    expect(result.reasons).not.toContain('SENIORITY_OVERQUALIFIED');
    expect(result.verdict).toBe('stretch'); // over_qualified isn't in the safe_apply {fits, unknown} set
  });

  it('low (non-null) coverage blocks safe_apply even with a strong score + fits seniority', () => {
    const result = classifyFit(
      base({ score: 80, required_coverage: 0.5, seniority_verdict: 'fits' }),
    );
    expect(result.verdict).toBe('stretch');
    expect(result.reasons).toEqual(
      expect.arrayContaining(['STRONG_SCORE', 'LOW_COVERAGE', 'SENIORITY_FITS']),
    );
  });

  it('mild seniority stretch (no severe_stretch, no level_gap — match path) keeps a strong score out of safe_apply', () => {
    const result = classifyFit(
      base({ score: 80, required_coverage: 0.9, seniority_verdict: 'stretch' }),
    );
    expect(result.verdict).toBe('stretch');
    expect(result.reasons).toEqual(
      expect.arrayContaining(['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_STRETCH']),
    );
  });

  it('match-path input never carries level_gap/severe_stretch — classifyFit does not crash on their absence', () => {
    const input: FitInput = {
      score: 55,
      required_coverage: null,
      seniority_verdict: 'unknown',
      unmet_deal_breakers: [],
    };
    expect(() => classifyFit(input)).not.toThrow();
    expect(classifyFit(input).verdict).toBe('stretch');
  });
});
