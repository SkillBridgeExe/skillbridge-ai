import {
  scoreStats,
  jaccardAcrossTrials,
  precisionRecall,
} from '../../src/calibration/determinism-metrics';

describe('determinism-metrics', () => {
  it('scoreStats reports min/max/median/stddev/maxAbsDelta, ignoring nulls', () => {
    const s = scoreStats([70, 72, 70, null, 76]);
    expect(s.min).toBe(70);
    expect(s.max).toBe(76);
    expect(s.median).toBe(71); // sorted [70,70,72,76] → (70+72)/2
    expect(s.maxAbsDelta).toBe(6); // 76 - 70
    expect(s.stddev).toBeGreaterThan(0);
    expect(s.n).toBe(4);
  });

  it('scoreStats on a perfectly stable series → maxAbsDelta 0, stddev 0', () => {
    const s = scoreStats([80, 80, 80]);
    expect(s.maxAbsDelta).toBe(0);
    expect(s.stddev).toBe(0);
  });

  it('scoreStats on all-null → safe zeros/nulls', () => {
    const s = scoreStats([null, null]);
    expect(s.n).toBe(0);
    expect(s.median).toBeNull();
    expect(s.maxAbsDelta).toBe(0);
  });

  it('jaccardAcrossTrials = mean pairwise Jaccard of the trial sets (1.0 when identical)', () => {
    expect(jaccardAcrossTrials([['a', 'b'], ['a', 'b'], ['a', 'b']])).toBeCloseTo(1.0, 5);
    // {a,b} vs {a,c}: |∩|=1 |∪|=3 → 1/3
    expect(jaccardAcrossTrials([['a', 'b'], ['a', 'c']])).toBeCloseTo(1 / 3, 5);
  });

  it('jaccardAcrossTrials with <2 trials → 1', () => {
    expect(jaccardAcrossTrials([['a', 'b']])).toBe(1);
    expect(jaccardAcrossTrials([])).toBe(1);
  });

  it('precisionRecall vs gold', () => {
    const pr = precisionRecall(['a', 'b', 'x'], ['a', 'b', 'c']); // extracted vs gold
    expect(pr.precision).toBeCloseTo(2 / 3, 5); // a,b correct of 3 extracted
    expect(pr.recall).toBeCloseTo(2 / 3, 5); // a,b of 3 gold
    expect(pr.missing).toEqual(['c']);
    expect(pr.extra).toEqual(['x']);
  });

  it('precisionRecall with empty gold → recall 1 (nothing required)', () => {
    const pr = precisionRecall(['a'], []);
    expect(pr.recall).toBe(1);
    expect(pr.precision).toBe(0); // a is extra
  });
});
