export type DataConfidence = 'high' | 'medium' | 'low';

/**
 * Per-role reliability from the active-postings sample size IN THE ROLE SCOPE (not the whole
 * platform). Thresholds: >=50 high · 20-49 medium · <20 low. Lets thin pools (e.g. a role with a
 * handful of active postings) be flagged honestly instead of over-claimed.
 */
export function dataConfidence(sampleSize: number): DataConfidence {
  if (sampleSize >= 50) return 'high';
  if (sampleSize >= 20) return 'medium';
  return 'low';
}

/**
 * #4: market-signal discount weight [0,1] per confidence tier for gap-severity ranking. A high-data
 * pool trusts pct_of_postings fully (1.0); thinner pools pull the market factor toward neutral so a
 * noisy few-posting percentage can't dominate the fix-priority order (see gap-item severity).
 */
export const MARKET_CONFIDENCE_WEIGHT: Record<DataConfidence, number> = {
  high: 1,
  medium: 0.6,
  low: 0.25,
};
