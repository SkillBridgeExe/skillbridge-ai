import { Injectable, Logger } from '@nestjs/common';
import { SkillTaxonomyService, TaxonomyEntry } from './skill-taxonomy.service';

export type NormalizationMatchType = 'exact' | 'alias' | 'fuzzy' | 'none';

export interface NormalizedSkill {
  /** canonical_name if matched, null if unrecognized */
  skill_id: string | null;
  /** Same as skill_id (kept for clarity in API responses) */
  canonical_name: string | null;
  /** Human display name from taxonomy, null if unrecognized */
  display_name: string | null;
  /** Original LLM-extracted name preserved for audit */
  raw_input: string;
  /** How we matched it */
  matched_via: NormalizationMatchType;
  /** 1.0 = certain, 0.7 = fuzzy guess, 0.0 = no match */
  confidence: number;
}

/**
 * Maps raw LLM-extracted skill text → canonical taxonomy ID.
 *
 * Three-pass strategy:
 *   1. EXACT — normalize key (lowercase, strip punctuation), look up in alias index.
 *      Hits "react.js" → "react" (because aliases includes "react.js").
 *   2. ALIAS — same as #1 but considered alias-hit if not the canonical itself.
 *   3. FUZZY — Levenshtein distance ≤ 2 against all alias keys.
 *      Hits "reactjs" → "react" if 2 chars away.
 *
 * NO LLM CALLS HERE. Pure deterministic code so cv→skills extraction is reproducible.
 *
 * Confidence levels:
 *   1.0 = exact canonical or display_name hit
 *   0.9 = alias hit (alias was an alternate spelling already in taxonomy)
 *   0.7 = fuzzy match (Levenshtein ≤ 2)
 *   0.0 = no match → consumer (SkillDiffService) flags as PENDING
 */
@Injectable()
export class SkillNormalizerService {
  private readonly logger = new Logger(SkillNormalizerService.name);

  /** Fuzzy match Levenshtein distance threshold. ≤ this = match. */
  private readonly FUZZY_THRESHOLD = 2;

  constructor(private readonly taxonomy: SkillTaxonomyService) {}

  normalizeRaw(rawName: string): NormalizedSkill {
    const raw = rawName ?? '';
    if (raw.trim().length === 0) {
      return this.unmatched(raw);
    }

    const key = SkillTaxonomyService.normalizeKey(raw);

    // Pass 1: exact / alias hit
    const direct = this.taxonomy.lookupByAliasKey(key);
    if (direct) {
      const entry = this.taxonomy.getByCanonical(direct);
      if (!entry) return this.unmatched(raw); // shouldn't happen but be safe

      const isCanonical = SkillTaxonomyService.normalizeKey(entry.canonical_name) === key;
      const isDisplay = SkillTaxonomyService.normalizeKey(entry.display_name) === key;
      const matchType: NormalizationMatchType = isCanonical || isDisplay ? 'exact' : 'alias';
      return {
        skill_id: entry.canonical_name,
        canonical_name: entry.canonical_name,
        display_name: entry.display_name,
        raw_input: raw,
        matched_via: matchType,
        confidence: matchType === 'exact' ? 1.0 : 0.9,
      };
    }

    // Pass 2: fuzzy. O(N) over all aliases — fine for ~50 skills × ~5 aliases = ~250 entries.
    let bestCanonical: string | null = null;
    let bestDistance = Infinity;
    for (const [aliasKey, canonical] of this.taxonomy.iterateAliasEntries()) {
      // Early skip: if length differs more than threshold, can't possibly match.
      if (Math.abs(aliasKey.length - key.length) > this.FUZZY_THRESHOLD) continue;
      const d = levenshtein(key, aliasKey, this.FUZZY_THRESHOLD);
      if (d < bestDistance) {
        bestDistance = d;
        bestCanonical = canonical;
        if (d === 0) break; // can't beat zero
      }
    }

    if (bestCanonical && bestDistance <= this.FUZZY_THRESHOLD) {
      const entry = this.taxonomy.getByCanonical(bestCanonical);
      if (entry) {
        return {
          skill_id: entry.canonical_name,
          canonical_name: entry.canonical_name,
          display_name: entry.display_name,
          raw_input: raw,
          matched_via: 'fuzzy',
          // Closer = more confident; distance 1 → 0.75, distance 2 → 0.65
          confidence: bestDistance === 1 ? 0.75 : 0.65,
        };
      }
    }

    return this.unmatched(raw);
  }

  normalizeMany(rawNames: string[]): NormalizedSkill[] {
    return rawNames.map((n) => this.normalizeRaw(n));
  }

  private unmatched(raw: string): NormalizedSkill {
    return {
      skill_id: null,
      canonical_name: null,
      display_name: null,
      raw_input: raw,
      matched_via: 'none',
      confidence: 0,
    };
  }

  /** Convenience for downstream services iterating canonical taxonomy. */
  getTaxonomyEntries(): TaxonomyEntry[] {
    return this.taxonomy.getAll();
  }
}

/**
 * Levenshtein distance with an upper bound (early exit).
 * Returns Infinity if distance exceeds `maxDistance` — caller can skip.
 *
 * Standard DP, O(a*b) time, O(b) space. For our usage (strings < 30 chars,
 * ~250 alias entries), runs in microseconds.
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return Infinity;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    // Early exit if entire row exceeds threshold
    if (rowMin > maxDistance) return Infinity;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
