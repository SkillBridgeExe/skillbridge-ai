import { ValidationStatus } from '../roadmap/learning-resource';
import {
  CURATION_FLAGS,
  CurationFlag,
  CurationInput,
  CuratedResource,
  groundCuration,
} from './curation-scoring';
import { levelsToCraap } from './curation-levels';

/**
 * Deterministic curation eval (no LLM). Mirrors learning-eval: a golden set of hand-labeled candidates +
 * a pure scorer. Skeleton mode runs each case's expected levels/flags through the REAL adapter + core to
 * prove the golden labels are self-consistent with the decision rules; --live swaps in CurationService.
 */

const CRAAP_KEYS = ['relevance', 'authority', 'currency', 'accuracy', 'purpose'] as const;
type CraapKey = (typeof CRAAP_KEYS)[number];

export interface CurationEvalCase {
  id: string;
  category: string;
  input: CurationInput;
  expected_levels: Record<CraapKey, number>; // 0-3 anchored
  expected_flags: CurationFlag[];
  expected_status: ValidationStatus;
  expected_quality_band: [number, number];
}

export interface CurationEvalResult {
  id: string;
  decision_match: boolean;
  no_raw_url: boolean;
  flags_subset: boolean;
  quality_in_band: boolean;
  pass: boolean;
}

// Match-or-stricter than cleanDescription's strip, so the harness actually fails on a surviving bare-host link.
const RAW_URL = /(https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\/)/i;

export function scoreCurationCase(c: CurationEvalCase, out: CuratedResource): CurationEvalResult {
  const decision_match = out.validation_status === c.expected_status;
  const no_raw_url = !RAW_URL.test(out.description);
  const flags_subset = out.flags.every((f) => (CURATION_FLAGS as readonly string[]).includes(f));
  const quality_in_band =
    out.quality_score >= c.expected_quality_band[0] &&
    out.quality_score <= c.expected_quality_band[1];
  return {
    id: c.id,
    decision_match,
    no_raw_url,
    flags_subset,
    quality_in_band,
    pass: decision_match && no_raw_url && flags_subset && quality_in_band,
  };
}

/** Skeleton producer: run the case's expected levels/flags through the REAL adapter + deterministic core. */
export function skeletonCurate(c: CurationEvalCase): CuratedResource {
  const craapLevels = Object.fromEntries(
    CRAAP_KEYS.map((k) => [k, { level: c.expected_levels[k] }]),
  );
  const craap = levelsToCraap(craapLevels);
  return groundCuration(
    { craap, flags: c.expected_flags, description: c.input.description ?? c.input.title },
    c.input,
  );
}
