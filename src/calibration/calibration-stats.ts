/**
 * Pure statistics for the CV-review calibration harness.
 *
 * Acceptance (R1 spec): for each CV, scoring the SAME input multiple times must
 * be near-deterministic — sample stddev(overall_score) < 5. These functions have
 * no I/O so they are unit-tested directly (calibration-stats.spec.ts).
 */

export interface CvRunResult {
  id: string;
  targetRole: string;
  /** overall_score from each repeated review() call. */
  scores: number[];
}

export interface CvStats {
  id: string;
  targetRole: string;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  pass: boolean;
}

export interface CalibrationVerdict {
  pass: boolean;
  failed: string[];
  maxStddev: number;
  threshold: number;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than 2 samples. */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

export function summarizeCv(run: CvRunResult, threshold = 5): CvStats {
  const sd = stddev(run.scores);
  return {
    id: run.id,
    targetRole: run.targetRole,
    mean: round2(mean(run.scores)),
    stddev: round2(sd),
    min: run.scores.length ? Math.min(...run.scores) : 0,
    max: run.scores.length ? Math.max(...run.scores) : 0,
    pass: sd < threshold,
  };
}

export function overallVerdict(stats: CvStats[], threshold = 5): CalibrationVerdict {
  const failed = stats.filter((s) => s.stddev >= threshold).map((s) => s.id);
  const maxStddev = stats.reduce((mx, s) => Math.max(mx, s.stddev), 0);
  return { pass: failed.length === 0, failed, maxStddev: round2(maxStddev), threshold };
}
