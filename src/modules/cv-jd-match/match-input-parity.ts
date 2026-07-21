/**
 * PARITY (2026-07-21) — close the paste-vs-card score split on the SAME JD.
 *
 * Both surfaces score through SkillDiffService with identical MATCH_TUNING, but their
 * INPUTS diverged, measured on prod as 100/100 (paste) vs 45% (job card) for one JD:
 *
 *   - Requirements: the paste path scored only the LLM's headline extraction (framework/
 *     tool mentions dropped), while the card scores the ingest gazetteer's literal
 *     superset — 5 requirements vs 8-12, and every dropped one silently left the
 *     denominator, inflating required_coverage to 1.0.
 *   - CV levels: the paste path re-extracted the CV fresh (missing hint → engine default 3
 *     → "3 >= 3" trivially met), while the card reads the stored review's evidence-graded
 *     hints (R1 doctrine: every job-scoring surface scores from the SAME fact set).
 *
 * These helpers run at the ORCHESTRATION layer (CvJdMatchService) so the diff engine
 * stays pure and eval-gated. Both are no-ops when their extra data source is absent.
 */
import { PROFICIENCY_TO_LEVEL } from '../../common/services/proficiency-calibration';
import { ScannedSkill } from '../../common/services/skill-text-scanner.service';
import { ReviewSkills } from './cv-review-facts';
import { RawCvSkill, RawJdRequirement } from './skill-diff.service';

/** Canonical hits for a free-text mention ([] = not in taxonomy). */
export type NormalizeFn = (name: string) => string[];

function hintToLevel(hint: string | undefined | null): number | null {
  if (!hint) return null;
  const level = PROFICIENCY_TO_LEVEL[hint.toUpperCase() as keyof typeof PROFICIENCY_TO_LEVEL];
  return typeof level === 'number' ? level : null;
}

const LEVEL_TO_HINT: Record<number, string> = Object.fromEntries(
  Object.entries(PROFICIENCY_TO_LEVEL).map(([hint, level]) => [level, hint]),
);

/**
 * Requirements = LLM extraction ∪ gazetteer scan of the same JD text.
 *
 * The gazetteer is the exact extractor the job card scores with (jd-ingest), so any
 * skill it finds that the LLM summarized away re-enters the denominator here instead of
 * silently vanishing. Scanner hits are already canonical; they carry the literal matched
 * surface as evidence. LLM entries keep precedence — they may carry level/importance
 * hints the scanner cannot know.
 */
export function unionJdRequirements(
  llmRaw: RawJdRequirement[],
  scanned: ScannedSkill[],
  normalize: NormalizeFn,
): RawJdRequirement[] {
  const covered = new Set<string>();
  for (const req of llmRaw) {
    for (const canonical of normalize(req.name)) covered.add(canonical);
  }
  const additions: RawJdRequirement[] = [];
  for (const hit of scanned) {
    if (covered.has(hit.canonical_name)) continue;
    covered.add(hit.canonical_name);
    additions.push({
      name: hit.canonical_name,
      // ponytail: ingest defaults REQUIRED too; section-aware NICE_TO_HAVE (ưu tiên/nice-to-have
      // headers, jd-ingest.extractSkills) is the upgrade path if this over-weights extras.
      importance_hint: 'REQUIRED',
      evidence_text: hit.matched_text,
    });
  }
  return additions.length === 0 ? llmRaw : [...llmRaw, ...additions];
}

/**
 * CV levels = the stored review's evidence-graded hints, reconciled anti-inflation:
 *
 *   - LLM hint missing → review hint fills it (instead of the engine's default 3).
 *   - Both present → the LOWER level wins (a fresh extraction cannot out-claim the
 *     evidence-graded review; mirrors the de-inflation stance the card already has).
 *   - Review skills the fresh extraction missed are appended (the card scores the full
 *     review set — the paste must not quietly score a thinner CV).
 *
 * No review (fresh CV / review failed) → the LLM extraction passes through unchanged.
 */
export function reconcileCvProficiency(
  llmRaw: RawCvSkill[],
  review: ReviewSkills | null,
  normalize: NormalizeFn,
): RawCvSkill[] {
  if (!review || review.length === 0) return llmRaw;

  // Per-canonical review level, max within the review (mirrors the diff's own
  // max-per-canonical rule for compound entries).
  const reviewLevelByCanonical = new Map<string, number>();
  const reviewNameByCanonical = new Map<string, string>();
  for (const skill of review) {
    const level = hintToLevel(skill.proficiency_hint);
    if (level === null) continue;
    for (const canonical of normalize(skill.name)) {
      const prev = reviewLevelByCanonical.get(canonical);
      if (prev === undefined || level > prev) {
        reviewLevelByCanonical.set(canonical, level);
        reviewNameByCanonical.set(canonical, skill.name);
      }
    }
  }

  const llmCovered = new Set<string>();
  const reconciled = llmRaw.map((raw) => {
    const canonicals = normalize(raw.name);
    for (const canonical of canonicals) llmCovered.add(canonical);
    const reviewLevels = canonicals
      .map((c) => reviewLevelByCanonical.get(c))
      .filter((l): l is number => l !== undefined);
    if (reviewLevels.length === 0) return raw;
    const reviewLevel = Math.max(...reviewLevels);
    const llmLevel = hintToLevel(raw.proficiency_hint);
    if (llmLevel !== null && llmLevel <= reviewLevel) return raw;
    return { ...raw, proficiency_hint: LEVEL_TO_HINT[reviewLevel] };
  });

  // Review skills the fresh extraction missed — presence-only entries with the review hint.
  const additions: RawCvSkill[] = [];
  for (const [canonical, level] of reviewLevelByCanonical) {
    if (llmCovered.has(canonical)) continue;
    llmCovered.add(canonical);
    additions.push({
      name: reviewNameByCanonical.get(canonical) ?? canonical,
      proficiency_hint: LEVEL_TO_HINT[level],
    });
  }
  return additions.length === 0 ? reconciled : [...reconciled, ...additions];
}
