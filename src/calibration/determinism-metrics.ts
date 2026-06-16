/** Pure, dependency-free metrics for the cv-jd-match determinism harness. No I/O, no LLM. */

export interface ScoreStats {
  n: number;
  min: number | null;
  max: number | null;
  median: number | null;
  stddev: number;
  /** max - min across non-null trials; the primary determinism gate (≤3 good / ≤5 ok / >5 fail). */
  maxAbsDelta: number;
}

export function scoreStats(scores: Array<number | null>): ScoreStats {
  const xs = scores.filter((x): x is number => x !== null);
  if (xs.length === 0) {
    return { n: 0, min: null, max: null, median: null, stddev: 0, maxAbsDelta: 0 };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const stddev = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
  return { n: xs.length, min, max, median, stddev, maxAbsDelta: max - min };
}

/** Mean pairwise Jaccard across N trial sets. Returns 1 for <2 trials. */
export function jaccardAcrossTrials(trials: string[][]): number {
  const sets = trials.map((t) => new Set(t));
  if (sets.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i];
      const b = sets[j];
      const inter = [...a].filter((x) => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      total += union === 0 ? 1 : inter / union;
      pairs++;
    }
  }
  return pairs === 0 ? 1 : total / pairs;
}

export interface PrecisionRecall {
  precision: number;
  recall: number;
  missing: string[]; // gold skills not extracted
  extra: string[]; // extracted skills not in gold
}

export function precisionRecall(extracted: string[], gold: string[]): PrecisionRecall {
  const e = new Set(extracted);
  const g = new Set(gold);
  const tp = [...e].filter((x) => g.has(x)).length;
  return {
    precision: e.size === 0 ? 0 : tp / e.size,
    recall: g.size === 0 ? 1 : tp / g.size,
    missing: [...g].filter((x) => !e.has(x)),
    extra: [...e].filter((x) => !g.has(x)),
  };
}
