import {
  compareToBaseline,
  toBaseline,
  Baseline,
  BaselineMargins,
  EvalSummary,
} from '../../src/calibration/eval-baseline';

const MARGINS: BaselineMargins = {
  overall: 5,
  spearman: 0.05,
  dim: 10,
  absFloorPct: 80,
  absSpearmanFloor: 0.6,
};

const baseline: Baseline = {
  generated: '2026-06-08',
  model: 'gpt-x',
  scoring_weights_version: 'scoring-weights-v1',
  overall: { within_band_pct: 94, spearman: 0.98, mae: 2 },
  per_dim: { action_verbs: 85, skills_relevance: 92, experience: 100, education: 100 },
};
const good: EvalSummary = {
  overallWithinBandPct: 92,
  spearman: 0.96,
  perDimWithinBandPct: { action_verbs: 85, skills_relevance: 92, experience: 100, education: 100 },
};

describe('compareToBaseline', () => {
  it('passes within margin of the baseline', () => {
    expect(compareToBaseline(good, baseline, MARGINS).pass).toBe(true);
  });

  it('fails on overall within-band regression beyond margin', () => {
    const r = compareToBaseline({ ...good, overallWithinBandPct: 88 }, baseline, MARGINS);
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/overall/i);
  });

  it('fails on Spearman regression beyond margin', () => {
    const r = compareToBaseline({ ...good, spearman: 0.9 }, baseline, MARGINS);
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/spearman/i);
  });

  it('fails on a per-dimension regression (Dim-2) beyond margin', () => {
    const r = compareToBaseline(
      { ...good, perDimWithinBandPct: { ...good.perDimWithinBandPct, skills_relevance: 81 } },
      baseline,
      MARGINS,
    );
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/skills_relevance/);
  });

  it('absolute floor fails even with NO baseline', () => {
    const r = compareToBaseline({ ...good, overallWithinBandPct: 70 }, null, MARGINS);
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/FLOOR/);
  });

  it('no baseline + above floor → pass (today behavior)', () => {
    expect(compareToBaseline(good, null, MARGINS).pass).toBe(true);
  });

  it('toBaseline round-trips: a run compared to its own snapshot passes', () => {
    const b = toBaseline(good, {
      generated: '2026-06-08',
      model: 'gpt-x',
      scoring_weights_version: 'scoring-weights-v1',
      mae: 2,
    });
    expect(compareToBaseline(good, b, MARGINS).pass).toBe(true);
    expect(b.per_dim.skills_relevance).toBe(92);
  });
});
