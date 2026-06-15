/**
 * PURE deterministic proficiency calibration. No NestJS DI, no I/O, no LLM (like text-metrics.ts).
 *
 * Single source of truth for the categorical proficiency enum → numeric level map, plus two
 * deterministic helpers used to harden/observe level claims:
 *  - qualifierToProficiency: maps an EN/VN qualifier WORD found in free text to a proficiency.
 *  - capForEvidence: the anti-inflate rule "listed-only ≠ ADVANCED" as a pure, testable function.
 *
 * ⚠️ SCOPE: `capForEvidence` is consumed ONLY by `eval:proficiency` (the invariant gate) and the
 * cv-jd-match cross-check telemetry. It is NOT applied in `skill-diff` or any scoring path — this
 * module does NOT cap live production levels. `PROFICIENCY_TO_LEVEL` is the verbatim table relocated
 * from skill-diff (identical values) so both share one source; relocating a constant does not change
 * any score.
 */

export type Proficiency = 'BEGINNER' | 'NOVICE' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';

/** Verbatim relocation of skill-diff's PROFICIENCY_TO_LEVEL (same values + key order). */
export const PROFICIENCY_TO_LEVEL: Record<Proficiency, number> = {
  BEGINNER: 1,
  NOVICE: 2,
  INTERMEDIATE: 3,
  ADVANCED: 4,
  EXPERT: 5,
};

/** INTERMEDIATE numeric level — the cap ceiling for non-demonstrated evidence. */
const INTERMEDIATE_LEVEL = PROFICIENCY_TO_LEVEL.INTERMEDIATE;

/**
 * EN + VN qualifier words → proficiency, in DESCENDING specificity so a string with several
 * qualifiers resolves to the strongest (e.g. "basic but now expert" → EXPERT).
 */
const QUALIFIER_TERMS: ReadonlyArray<readonly [Proficiency, readonly string[]]> = [
  ['EXPERT', ['expert', 'mastery', 'chuyên sâu', 'chuyên gia']],
  ['ADVANCED', ['advanced', 'strong', 'proficient', 'thành thạo', 'giỏi']],
  ['INTERMEDIATE', ['intermediate', 'khá']],
  ['NOVICE', ['familiar', 'novice', 'làm quen']],
  ['BEGINNER', ['basic', 'beginner', 'cơ bản']],
];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Unicode-aware word-boundary match: JS `\b` is ASCII-only and breaks on Vietnamese diacritics, so
 * we use lookarounds that reject an adjacent letter/number. "basic" matches in "basic React" but not
 * in "basics"; "master" never leaks from "masterclass".
 */
const boundedTerm = (term: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, 'u');

/**
 * Extract a proficiency from a qualifier word present in free text, or null when none is present.
 * `null` is NOT inflation — it means "no explicit qualifier", which callers treat as no signal.
 */
export function qualifierToProficiency(text: string): Proficiency | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  for (const [prof, terms] of QUALIFIER_TERMS) {
    for (const term of terms) {
      if (boundedTerm(term).test(hay)) return prof;
    }
  }
  return null;
}

/**
 * Anti-inflate rule: a skill that is only listed/mentioned (not demonstrated) cannot be claimed at
 * ADVANCED/EXPERT — cap it at INTERMEDIATE. Pure + deterministic. Telemetry/gate ONLY (see header).
 */
export function capForEvidence(
  prof: Proficiency,
  evidence: 'demonstrated' | 'listed_only' | 'mentioned',
): Proficiency {
  if (evidence !== 'demonstrated' && PROFICIENCY_TO_LEVEL[prof] > INTERMEDIATE_LEVEL) {
    return 'INTERMEDIATE';
  }
  return prof;
}
