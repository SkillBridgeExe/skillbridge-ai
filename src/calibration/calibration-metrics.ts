/**
 * Pure ground-truth calibration metrics — compare a heuristic/LLM output against human labels.
 * No IO, no deps. Metric choice follows the research playbook (docs/superpowers/CALIBRATION-PLAYBOOK.md):
 *   binary/nominal → Cohen's kappa + F1 (raw %-agreement is untrustworthy; chance-correct it).
 *   ordinal bands  → quadratic-weighted kappa (QWK ≥ 0.70 = field-standard acceptance).
 *   count/continuous → MAE / RMSE.
 *   any metric     → bootstrap CI (tiny N ⇒ wide interval; be honest the number is uncertain).
 * ALWAYS inspect confusionMatrix too — the "kappa paradox" lets high %-agreement hide a low kappa.
 */

/** Cohen's kappa for two equal-length nominal/binary label arrays. 0 on empty/mismatched length. */
export function cohenKappa(a: string[], b: string[]): number {
  const n = a.length;
  if (n === 0 || b.length !== n) return 0;
  let agree = 0;
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree += 1;
    ca.set(a[i], (ca.get(a[i]) ?? 0) + 1);
    cb.set(b[i], (cb.get(b[i]) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [k, va] of ca) pe += (va / n) * ((cb.get(k) ?? 0) / n);
  if (1 - pe === 0) return po === 1 ? 1 : 0; // one category dominates both raters
  return (po - pe) / (1 - pe);
}

/**
 * Quadratic-weighted kappa for ordinal integer labels in [0, numCategories-1]. Distant band errors are
 * penalised quadratically. Returns 1 on perfect agreement, -1 on perfect inverse, ~0 on chance.
 */
export function quadraticWeightedKappa(a: number[], b: number[], numCategories: number): number {
  const n = a.length;
  if (n === 0 || b.length !== n) return 0;
  if (numCategories < 2) return a.every((x, i) => x === b[i]) ? 1 : 0;
  const K = numCategories;
  const O: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
  const rowT = new Array(K).fill(0);
  const colT = new Array(K).fill(0);
  for (let i = 0; i < n; i++) {
    O[a[i]][b[i]] += 1;
    rowT[a[i]] += 1;
    colT[b[i]] += 1;
  }
  const w = (i: number, j: number): number => ((i - j) * (i - j)) / ((K - 1) * (K - 1));
  let num = 0;
  let den = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      const e = (rowT[i] * colT[j]) / n;
      num += w(i, j) * O[i][j];
      den += w(i, j) * e;
    }
  }
  if (den === 0) return 1; // no expected disagreement possible → perfect
  return 1 - num / den;
}

/** Precision / recall / F1 / accuracy for a binary heuristic (predicted) vs human label (actual). */
export function binaryAgreement(
  predicted: boolean[],
  actual: boolean[],
): { precision: number; recall: number; f1: number; accuracy: number } {
  const n = predicted.length;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < n; i++) {
    if (predicted[i] && actual[i]) tp += 1;
    else if (predicted[i] && !actual[i]) fp += 1;
    else if (!predicted[i] && actual[i]) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = n === 0 ? 0 : (tp + tn) / n;
  return { precision, recall, f1, accuracy };
}

/** Mean absolute error for count/continuous signals (e.g. filler_count vs human count). */
export function mae(predicted: number[], actual: number[]): number {
  const n = predicted.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(predicted[i] - actual[i]);
  return s / n;
}

/** Root mean squared error. */
export function rmse(predicted: number[], actual: number[]): number {
  const n = predicted.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = predicted[i] - actual[i];
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/** rows = actual label, cols = predicted label (order of `labels`). Inspect this for the kappa paradox. */
export function confusionMatrix(
  predicted: string[],
  actual: string[],
  labels: string[],
): number[][] {
  const idx = new Map(labels.map((l, i) => [l, i]));
  const m: number[][] = labels.map(() => new Array(labels.length).fill(0));
  for (let i = 0; i < predicted.length; i++) {
    const r = idx.get(actual[i]);
    const c = idx.get(predicted[i]);
    if (r === undefined || c === undefined) continue;
    m[r][c] += 1;
  }
  return m;
}

/** small deterministic PRNG so bootstrap CIs are reproducible in tests + CI. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap confidence interval for any statistic of `values`. Deterministic (seeded).
 * With tiny N the interval is WIDE — that width is the honest message: the metric is uncertain.
 */
export function bootstrapCI(
  values: number[],
  statFn: (v: number[]) => number,
  opts: { iterations?: number; alpha?: number; seed?: number } = {},
): { point: number; lo: number; hi: number } {
  const { iterations = 2000, alpha = 0.05, seed = 12345 } = opts;
  const n = values.length;
  const point = statFn(values);
  if (n === 0) return { point, lo: point, hi: point };
  const rand = mulberry32(seed);
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const sample = new Array<number>(n);
    for (let i = 0; i < n; i++) sample[i] = values[Math.floor(rand() * n)];
    stats.push(statFn(sample));
  }
  stats.sort((x, y) => x - y);
  const lo = stats[Math.floor((alpha / 2) * iterations)];
  const hi = stats[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))];
  return { point, lo, hi };
}
