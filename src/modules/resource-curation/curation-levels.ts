import { CraapScores } from './curation-scoring';

const CRAAP_KEYS: (keyof CraapScores)[] = [
  'relevance',
  'authority',
  'currency',
  'accuracy',
  'purpose',
];
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * Calibration adapter. The prompt scores each CRAAP dimension on an ANCHORED discrete level 0-3 (behavioral
 * descriptors per level) — far more consistent/reproducible than a free 0-1 float, because discretization
 * kills score-clustering and temperature-0 jitter (a tiny wobble can't flip a level). This maps level → the
 * 0-1 float the deterministic core (groundCuration) consumes, keeping that core pure + already-tested.
 * Lenient: accepts a `{ level }` object OR a bare number per dimension; clamps to [0,1]; missing → 0.
 */
export function levelsToCraap(parsedCraap: unknown): CraapScores {
  const o = (parsedCraap && typeof parsedCraap === 'object' ? parsedCraap : {}) as Record<
    string,
    unknown
  >;
  const toFloat = (key: string): number => {
    const dim = o[key];
    const raw = dim && typeof dim === 'object' ? (dim as Record<string, unknown>).level : dim;
    const level = typeof raw === 'number' ? raw : 0;
    return clamp01(level / 3);
  };
  return CRAAP_KEYS.reduce((acc, k) => {
    acc[k] = toFloat(k);
    return acc;
  }, {} as CraapScores);
}
