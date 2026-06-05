/**
 * Reciprocal Rank Fusion — fuse N ranked lists by rank (not score), the standard hybrid
 * retrieval combiner: fused(d) = Σ_lists 1 / (k + rank_d). Rank-based fusion needs NO score
 * normalization across signals (deterministic 0-100 match score vs cosine similarity), which
 * is exactly why it beats weighted-sum here. k=60 is the literature default.
 */
export const RRF_K = 60;

export function rrfFuse(rankedLists: string[][], k: number = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return fused;
}
