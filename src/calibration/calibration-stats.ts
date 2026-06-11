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
  // Use summarizeCv's own pass flag (computed on the RAW stddev) as the single source of
  // truth, so the verdict can't disagree with per-CV pass at the rounding boundary.
  const failed = stats.filter((s) => !s.pass).map((s) => s.id);
  const maxStddev = stats.reduce((mx, s) => Math.max(mx, s.stddev), 0);
  return { pass: failed.length === 0, failed, maxStddev: round2(maxStddev), threshold };
}

// ─── Accuracy metrics (calibration spine: AI score vs expected) ───────────────

/** Mean absolute error between paired predicted/expected arrays. */
export function mae(predicted: number[], expected: number[]): number {
  if (predicted.length !== expected.length) {
    throw new Error(`mae: array length mismatch (${predicted.length} vs ${expected.length})`);
  }
  const n = predicted.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(predicted[i] - expected[i]);
  return round2(s / n);
}

/** Average 1-based ranks; tied values share the mean rank. */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(xs.length).fill(0);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avgRank = (k + j) / 2 + 1; // mean 1-based rank across the tie group
    for (let t = k; t <= j; t++) r[idx[t].i] = avgRank;
    k = j + 1;
  }
  return r;
}

/** Pearson correlation in [-1,1]; returns 0 when undefined (zero variance / <2 points). */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return round2(num / Math.sqrt(da * db));
}

/**
 * Spearman rank correlation — Pearson on ranks (tolerates ties). Measures whether the
 * scorer can ORDER CVs correctly (the key property for roadmap prioritization), not just
 * land in a band. Range [-1,1].
 */
export function spearman(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  return pearson(ranks(a.slice(0, n)), ranks(b.slice(0, n)));
}

// ─── Two-series agreement (panel/external-reference comparisons) ──────────────

export interface AgreementStats {
  /** Number of ids present on BOTH sides (the joined sample). */
  n: number;
  spearman: number;
  mae: number;
  within_15_count: number;
  within_15_pct: number;
}

/**
 * Agreement between two score series joined by id (ids missing on either side are
 * skipped). Used for system-vs-external-judge and panel-vs-external comparisons —
 * pure so the panel harness stays testable without LLM calls.
 */
export function scoreAgreement(
  a: Array<{ id: string; score: number }>,
  b: Array<{ id: string; score: number }>,
): AgreementStats {
  const bById = new Map(b.map((x) => [x.id, x.score]));
  const pairsA: number[] = [];
  const pairsB: number[] = [];
  for (const x of a) {
    const other = bById.get(x.id);
    if (other === undefined) continue;
    pairsA.push(x.score);
    pairsB.push(other);
  }
  if (pairsA.length < 2) {
    return { n: 0, spearman: 0, mae: 0, within_15_count: 0, within_15_pct: 0 };
  }
  const within = pairsA.filter((v, i) => Math.abs(v - pairsB[i]) <= 15).length;
  return {
    n: pairsA.length,
    spearman: spearman(pairsA, pairsB),
    mae: mae(pairsA, pairsB),
    within_15_count: within,
    within_15_pct: round2((within / pairsA.length) * 100),
  };
}
