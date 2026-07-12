import { classifyFit, FitInput } from './fit-strategy';

/**
 * Pins the CURRENT behavior of classifyFit() against data/fit-policy-v1.json
 * (not_recommended_score_below=40, safe_apply_score_at_least=65,
 * safe_apply_coverage_at_least=0.7, overqualified_severe_level_gap_at_least=3).
 * Pure-function tests — no LLM, no DB. Reason arrays are asserted EXACTLY (content + order):
 * the emission order is fixed by the if-chain in fit-strategy.ts and the FE renders the trail.
 */
describe('classifyFit — fit-policy-v1 boundaries + reason trail (Wave ACTION A1)', () => {
  // Strong-everything baseline on the match path (mirrors gap-report/eval-golden call shape).
  const base = (over: Partial<FitInput> = {}): FitInput => ({
    score: 80,
    required_coverage: 0.9,
    seniority_verdict: 'fits',
    unmet_deal_breakers: [],
    unverified_deal_breakers: [],
    ...over,
  });

  describe('score thresholds (65 safe_apply / 40 not_recommended cut points)', () => {
    it('score exactly 65 is STRONG_SCORE -> safe_apply', () => {
      expect(classifyFit(base({ score: 65 }))).toEqual({
        verdict: 'safe_apply',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_FITS'],
      });
    });

    it('score 64.99 (just under) drops to stretch with MID_SCORE, positives still emitted', () => {
      expect(classifyFit(base({ score: 64.99 }))).toEqual({
        verdict: 'stretch',
        reasons: ['STRONG_COVERAGE', 'SENIORITY_FITS', 'MID_SCORE'],
      });
    });

    it('score exactly 40 is NOT low — mid-band stretch, no LOW_SCORE', () => {
      expect(classifyFit(base({ score: 40 }))).toEqual({
        verdict: 'stretch',
        reasons: ['STRONG_COVERAGE', 'SENIORITY_FITS', 'MID_SCORE'],
      });
    });

    it('score 39.99 (just under 40) -> not_recommended via LOW_SCORE, despite perfect coverage/seniority', () => {
      expect(classifyFit(base({ score: 39.99 }))).toEqual({
        verdict: 'not_recommended',
        reasons: ['STRONG_COVERAGE', 'SENIORITY_FITS', 'LOW_SCORE'],
      });
    });
  });

  describe('required_coverage threshold (0.7) and null coverage', () => {
    it('coverage exactly 0.7 counts as STRONG_COVERAGE -> safe_apply', () => {
      expect(classifyFit(base({ required_coverage: 0.7 }))).toEqual({
        verdict: 'safe_apply',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_FITS'],
      });
    });

    it('coverage 0.69 (just under) blocks safe_apply -> stretch with LOW_COVERAGE', () => {
      expect(classifyFit(base({ required_coverage: 0.69 }))).toEqual({
        verdict: 'stretch',
        reasons: ['STRONG_SCORE', 'SENIORITY_FITS', 'LOW_COVERAGE'],
      });
    });

    it('null coverage (job-rec path) emits NO coverage code and does not block safe_apply', () => {
      expect(classifyFit(base({ required_coverage: null }))).toEqual({
        verdict: 'safe_apply',
        reasons: ['STRONG_SCORE', 'SENIORITY_FITS'],
      });
    });
  });

  describe('seniority verdicts', () => {
    it("'unknown' does not block safe_apply and emits no seniority code", () => {
      expect(classifyFit(base({ seniority_verdict: 'unknown' }))).toEqual({
        verdict: 'safe_apply',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE'],
      });
    });

    it("'stretch' caps at stretch even with strong score + coverage", () => {
      expect(classifyFit(base({ seniority_verdict: 'stretch' }))).toEqual({
        verdict: 'stretch',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_STRETCH'],
      });
    });

    it("'over_qualified' with level_gap 3 (severe) -> not_recommended", () => {
      expect(classifyFit(base({ seniority_verdict: 'over_qualified', level_gap: 3 }))).toEqual({
        verdict: 'not_recommended',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_OVERQUALIFIED'],
      });
    });

    it('severe over-qualification uses |level_gap| — a gap of -3 also fires', () => {
      expect(classifyFit(base({ seniority_verdict: 'over_qualified', level_gap: -3 }))).toEqual({
        verdict: 'not_recommended',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_OVERQUALIFIED'],
      });
    });

    it("'over_qualified' with level_gap 2 (mild) -> stretch, and NO seniority reason code at all", () => {
      // Pinned surprise: mild over-qualification blocks safe_apply but the reason trail carries no
      // over-qualified code — only the positives explain the stretch.
      expect(classifyFit(base({ seniority_verdict: 'over_qualified', level_gap: 2 }))).toEqual({
        verdict: 'stretch',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE'],
      });
    });

    it("'over_qualified' with level_gap absent (match path) is never severe -> stretch", () => {
      expect(classifyFit(base({ seniority_verdict: 'over_qualified' }))).toEqual({
        verdict: 'stretch',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE'],
      });
    });
  });

  describe('deal-breakers', () => {
    it('an unmet deal-breaker forces not_recommended regardless of a perfect score', () => {
      expect(
        classifyFit(
          base({ score: 100, required_coverage: 1, unmet_deal_breakers: ['English C1'] }),
        ),
      ).toEqual({
        verdict: 'not_recommended',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_FITS', 'DEAL_BREAKER_UNMET'],
      });
    });

    it('an UNVERIFIED deal-breaker caps at stretch — never fabricates not_recommended', () => {
      expect(
        classifyFit(
          base({ score: 100, required_coverage: 1, unverified_deal_breakers: ['English C1'] }),
        ),
      ).toEqual({
        verdict: 'stretch',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_FITS', 'DEAL_BREAKER_UNVERIFIED'],
      });
    });

    it('unverified deal-breaker does not shield a genuinely low score from not_recommended', () => {
      expect(classifyFit(base({ score: 10, unverified_deal_breakers: ['English C1'] }))).toEqual({
        verdict: 'not_recommended',
        reasons: ['STRONG_COVERAGE', 'SENIORITY_FITS', 'LOW_SCORE', 'DEAL_BREAKER_UNVERIFIED'],
      });
    });

    it('unverified_deal_breakers omitted entirely (optional field) behaves as none', () => {
      const { unverified_deal_breakers: _drop, ...noField } = base();
      expect(classifyFit(noField)).toEqual({
        verdict: 'safe_apply',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_FITS'],
      });
    });
  });

  describe('severe_stretch (job-rec path)', () => {
    it('severe_stretch=true forces not_recommended even with strong everything', () => {
      expect(classifyFit(base({ severe_stretch: true }))).toEqual({
        verdict: 'not_recommended',
        reasons: ['STRONG_SCORE', 'STRONG_COVERAGE', 'SENIORITY_FITS', 'SEVERE_STRETCH'],
      });
    });

    it('severe_stretch=false is inert (identical to absent)', () => {
      expect(classifyFit(base({ severe_stretch: false }))).toEqual(classifyFit(base()));
    });
  });

  describe('reason-trail composition', () => {
    it('MID_SCORE still fires on a not_recommended verdict (deal-breaker at mid score)', () => {
      expect(
        classifyFit(
          base({
            score: 50,
            required_coverage: null,
            seniority_verdict: 'unknown',
            unmet_deal_breakers: ['5+ years'],
          }),
        ),
      ).toEqual({ verdict: 'not_recommended', reasons: ['DEAL_BREAKER_UNMET', 'MID_SCORE'] });
    });

    it('degenerate empty input (score 0, no coverage, unknown seniority) -> LOW_SCORE only', () => {
      expect(
        classifyFit({
          score: 0,
          required_coverage: null,
          seniority_verdict: 'unknown',
          unmet_deal_breakers: [],
        }),
      ).toEqual({ verdict: 'not_recommended', reasons: ['LOW_SCORE'] });
    });

    it('mid score + low coverage + seniority stretch stacks every applicable negative code', () => {
      expect(
        classifyFit(base({ score: 50, required_coverage: 0.3, seniority_verdict: 'stretch' })),
      ).toEqual({
        verdict: 'stretch',
        reasons: ['LOW_COVERAGE', 'SENIORITY_STRETCH', 'MID_SCORE'],
      });
    });
  });
});
