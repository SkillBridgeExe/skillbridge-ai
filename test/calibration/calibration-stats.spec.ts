import {
  mean,
  stddev,
  summarizeCv,
  overallVerdict,
  mae,
  spearman,
  pearson,
} from '../../src/calibration/calibration-stats';

describe('calibration-stats', () => {
  it('mean averages', () => {
    expect(mean([70, 80, 90])).toBe(80);
    expect(mean([])).toBe(0);
  });

  it('stddev is 0 for identical scores (perfectly reproducible)', () => {
    expect(stddev([75, 75, 75, 75])).toBe(0);
  });

  it('stddev uses sample (n-1) formula', () => {
    // [70,80,90] → variance = (100+0+100)/2 = 100 → stddev = 10
    expect(Math.round(stddev([70, 80, 90]))).toBe(10);
  });

  it('summarizeCv PASSES when stddev < 5 (stable scoring)', () => {
    const s = summarizeCv({
      id: 'x',
      targetRole: 'frontend_developer',
      scores: [77, 78, 79, 77, 78],
    });
    expect(s.pass).toBe(true);
    expect(s.mean).toBeCloseTo(77.8, 1);
  });

  it('summarizeCv FAILS when stddev >= 5 (unstable scoring)', () => {
    const s = summarizeCv({
      id: 'y',
      targetRole: 'backend_developer',
      scores: [60, 80, 70, 90, 65],
    });
    expect(s.pass).toBe(false);
  });

  it('overallVerdict flags any CV over threshold', () => {
    const stats = [
      summarizeCv({ id: 'a', targetRole: 'r', scores: [77, 78, 78] }),
      summarizeCv({ id: 'b', targetRole: 'r', scores: [50, 90, 70] }),
    ];
    const v = overallVerdict(stats);
    expect(v.pass).toBe(false);
    expect(v.failed).toContain('b');
  });

  it('mae computes mean absolute error', () => {
    expect(mae([10, 20, 30], [12, 18, 33])).toBeCloseTo(2.33, 2);
    expect(mae([5, 5], [5, 5])).toBe(0);
    expect(mae([], [])).toBe(0);
  });

  it('spearman is 1 for perfectly monotonic, -1 for reversed', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
  });

  it('spearman tolerates ties', () => {
    expect(spearman([1, 1, 2, 3], [5, 5, 6, 7])).toBe(1);
  });

  it('spearman/pearson are 0 with <2 points or zero variance', () => {
    expect(spearman([1], [1])).toBe(0);
    expect(pearson([5, 5, 5], [1, 2, 3])).toBe(0);
  });

  it('mae throws on length mismatch (paired arrays)', () => {
    expect(() => mae([1, 2], [1])).toThrow(/mismatch/);
  });
});
