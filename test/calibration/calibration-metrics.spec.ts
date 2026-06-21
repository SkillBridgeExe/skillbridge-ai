import {
  cohenKappa,
  quadraticWeightedKappa,
  binaryAgreement,
  mae,
  rmse,
  confusionMatrix,
  bootstrapCI,
} from '../../src/calibration/calibration-metrics';

describe('cohenKappa', () => {
  it('hand-computed: po=0.75, pe=0.5 -> kappa 0.5', () => {
    expect(cohenKappa(['y', 'y', 'n', 'n'], ['y', 'n', 'n', 'n'])).toBeCloseTo(0.5, 6);
  });
  it('perfect agreement -> 1 (even when one category dominates both raters)', () => {
    expect(cohenKappa(['a', 'a', 'a'], ['a', 'a', 'a'])).toBe(1);
  });
  it('empty / mismatched length -> 0', () => {
    expect(cohenKappa([], [])).toBe(0);
    expect(cohenKappa(['a'], ['a', 'b'])).toBe(0);
  });
});

describe('quadraticWeightedKappa', () => {
  it('perfect ordinal agreement -> 1', () => {
    expect(quadraticWeightedKappa([0, 1, 2], [0, 1, 2], 3)).toBe(1);
  });
  it('perfect inverse -> -1', () => {
    expect(quadraticWeightedKappa([0, 1, 2], [2, 1, 0], 3)).toBeCloseTo(-1, 6);
  });
  it('an adjacent error is penalised LESS than a distant error (quadratic weighting)', () => {
    const adjacent = quadraticWeightedKappa([0, 1, 2, 1], [0, 1, 2, 2], 3); // one off-by-1
    const distant = quadraticWeightedKappa([0, 1, 2, 0], [0, 1, 2, 2], 3); // one off-by-2
    expect(adjacent).toBeGreaterThan(distant);
  });
});

describe('binaryAgreement', () => {
  it('hand-computed precision/recall/f1/accuracy', () => {
    const r = binaryAgreement([true, true, false, false], [true, false, false, false]);
    expect(r.precision).toBeCloseTo(0.5, 6);
    expect(r.recall).toBeCloseTo(1, 6);
    expect(r.f1).toBeCloseTo(2 / 3, 6);
    expect(r.accuracy).toBeCloseTo(0.75, 6);
  });
  it('no positives predicted -> precision 0, no div-by-zero', () => {
    const r = binaryAgreement([false, false], [true, false]);
    expect(r.precision).toBe(0);
    expect(r.f1).toBe(0);
  });
});

describe('mae / rmse', () => {
  it('mae([1,2,3],[1,2,5]) = 2/3', () => {
    expect(mae([1, 2, 3], [1, 2, 5])).toBeCloseTo(2 / 3, 6);
  });
  it('rmse([1,2,3],[1,2,5]) = sqrt(4/3)', () => {
    expect(rmse([1, 2, 3], [1, 2, 5])).toBeCloseTo(Math.sqrt(4 / 3), 6);
  });
});

describe('confusionMatrix', () => {
  it('rows=actual, cols=predicted', () => {
    expect(confusionMatrix(['a', 'b', 'a'], ['a', 'a', 'b'], ['a', 'b'])).toEqual([
      [1, 1],
      [1, 0],
    ]);
  });
});

describe('bootstrapCI', () => {
  const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
  it('constant data -> zero-width CI at the point', () => {
    const ci = bootstrapCI([5, 5, 5], mean);
    expect(ci).toEqual({ point: 5, lo: 5, hi: 5 });
  });
  it('point equals the statistic on the full sample; CI brackets it; deterministic (seeded)', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = bootstrapCI(data, mean);
    const b = bootstrapCI(data, mean);
    expect(a.point).toBeCloseTo(5.5, 6);
    expect(a.lo).toBeLessThanOrEqual(a.point);
    expect(a.hi).toBeGreaterThanOrEqual(a.point);
    expect(a).toEqual(b); // seeded → reproducible
  });
});
