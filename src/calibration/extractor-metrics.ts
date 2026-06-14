/**
 * Extractor A/B metrics — a thin compatibility shim over the shared core in
 * src/common/services/text-metrics.ts. The metrics logic moved there so the live
 * `extraction_quality` signal and this eval harness share ONE implementation and can never
 * silently disagree. This file preserves the original import surface
 * (`{ computeMetrics, ExtractorMetrics }`) so eval-extractors.ts (and its contract spec) are unchanged.
 *
 * ExtractorMetrics is the legacy subset (no wordCount / mojibakeRatio); computeMetrics returns the
 * full TextMetrics, which is a strict superset — the extra fields are ignored by existing callers.
 */
import { computeTextMetrics, TextMetrics } from '../common/services/text-metrics';

/** Legacy alias. TextMetrics is a strict superset of the original ExtractorMetrics shape. */
export type ExtractorMetrics = TextMetrics;

export function computeMetrics(
  text: string,
  scan: (t: string) => { canonical_name: string }[],
): ExtractorMetrics {
  return computeTextMetrics(text, scan);
}
