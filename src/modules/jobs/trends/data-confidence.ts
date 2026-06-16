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
