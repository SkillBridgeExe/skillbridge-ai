import { ValidationStatus } from '../roadmap/learning-resource';
import { CurationFlag, CurationInput, CuratedResource, groundCuration } from './curation-scoring';
import { levelsToCraap } from './curation-levels';
import { providerTier, routeValidation } from './curation-signals';

/**
 * Deterministic curation eval (no LLM). Mirrors learning-eval. A golden set of hand-labeled candidates + a
 * pure scorer. skeletonCurate runs each case's expected levels/flags through the REAL adapter + core + the
 * SAME production gate the service applies (routeValidation), so the golden tests PRODUCTION behavior — not
 * just the lenient core. --live swaps in CurationService.curate and the per-dimension + flag metrics below
 * become the real calibration signal.
 */

const CRAAP_KEYS = ['relevance', 'authority', 'currency', 'accuracy', 'purpose'] as const;
type CraapKey = (typeof CRAAP_KEYS)[number];

export interface CurationEvalCase {
  id: string;
  category: string;
  input: CurationInput;
  expected_levels: Record<CraapKey, number>; // 0-3 anchored
  expected_flags: CurationFlag[];
  expected_status: ValidationStatus; // the PRODUCTION (post-gate) decision
  expected_quality_band: [number, number];
}

export interface CurationEvalResult {
  id: string;
  decision_match: boolean;
  no_raw_url: boolean;
  quality_in_band: boolean;
  /** # of CRAAP dimensions whose produced level exactly equals the gold level (0-5) — the calibration metric. */
  level_exact: number;
  /** # of dimensions within ±1 level (0-5). */
  level_within1: number;
  /** |produced ∩ gold flags| / |produced| (1 when produced is empty). */
  flag_precision: number;
  /** |produced ∩ gold flags| / |gold| (1 when gold is empty). */
  flag_recall: number;
  pass: boolean;
}

// Match-or-stricter than cleanDescription's strip so the harness fails on a surviving bare-host link.
const RAW_URL = /(https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\/)/i;

/** Recover the discrete 0-3 level the model effectively assigned, from the 0-1 float the core stored. */
const producedLevel = (craapFloat: number): number => Math.round(craapFloat * 3);

export function scoreCurationCase(c: CurationEvalCase, out: CuratedResource): CurationEvalResult {
  const decision_match = out.validation_status === c.expected_status;
  const no_raw_url = !RAW_URL.test(out.description);
  const quality_in_band =
    out.quality_score >= c.expected_quality_band[0] &&
    out.quality_score <= c.expected_quality_band[1];

  let level_exact = 0;
  let level_within1 = 0;
  for (const k of CRAAP_KEYS) {
    const diff = Math.abs(producedLevel(out.craap[k]) - c.expected_levels[k]);
    if (diff === 0) level_exact += 1;
    if (diff <= 1) level_within1 += 1;
  }

  const actual = new Set<string>(out.flags);
  const expected = new Set<string>(c.expected_flags);
  const inter = [...actual].filter((f) => expected.has(f)).length;
  const flag_precision = actual.size === 0 ? 1 : inter / actual.size;
  const flag_recall = expected.size === 0 ? 1 : inter / expected.size;

  return {
    id: c.id,
    decision_match,
    no_raw_url,
    quality_in_band,
    level_exact,
    level_within1,
    flag_precision,
    flag_recall,
    pass: decision_match && no_raw_url && quality_in_band,
  };
}

/** Skeleton producer: expected levels/flags → REAL adapter + core + the production gate (routeValidation). */
export function skeletonCurate(c: CurationEvalCase): CuratedResource {
  const craapLevels = Object.fromEntries(
    CRAAP_KEYS.map((k) => [k, { level: c.expected_levels[k] }]),
  );
  const craap = levelsToCraap(craapLevels);
  const core = groundCuration(
    { craap, flags: c.expected_flags, description: c.input.description ?? c.input.title },
    c.input,
  );
  return {
    ...core,
    validation_status: routeValidation(core, { providerTier: providerTier(c.input.provider) }),
  };
}
