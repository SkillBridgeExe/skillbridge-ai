import { CanonicalCvDocument } from '../../common/types/canonical-cv';
import { RawCvSkill } from '../cv-jd-match/skill-diff.service';

export type ReadinessBand = 'starting' | 'building' | 'ready';

/**
 * Story→CV readiness v1 (UNVALIDATED heuristic). Blends the UNCAPPED rubric match score with REQUIRED
 * coverage: readiness = 0.6·matchScore + 40·required_coverage, clamped 0-100. Deterministic.
 * IMPORTANT: pass the uncapped raw weighted score, NOT overall_score — overall_score is already
 * min(raw, 45 + 55·coverage), so passing it double-counts coverage in the missing-required regime.
 * NOTE: the 0.6/40 weights are judgment, not calibrated against a gold set — revisit with eval data.
 */
export function computeReadiness(
  matchScore: number,
  requiredCoverage: number,
): { readiness: number; band: ReadinessBand } {
  const readiness = Math.max(
    0,
    Math.min(100, Math.round(0.6 * matchScore + 40 * requiredCoverage)),
  );
  const band: ReadinessBand = readiness < 40 ? 'starting' : readiness < 70 ? 'building' : 'ready';
  return { readiness, band };
}

/**
 * Extract the user's skills from the STRUCTURED CV document (no LLM, no fabrication): the technical
 * skills list + every project's tech list, deduped by lowercased name. Feeds SkillDiffService.diff.
 */
export function cvSkillsFromDoc(doc: CanonicalCvDocument): RawCvSkill[] {
  const seen = new Set<string>();
  const out: RawCvSkill[] = [];
  const push = (name: string): void => {
    const n = (name ?? '').trim();
    const key = n.toLowerCase();
    if (!n || seen.has(key)) return;
    seen.add(key);
    out.push({ name: n });
  };
  for (const s of doc.skills?.technical ?? []) push(s);
  for (const p of doc.projects ?? []) for (const t of p.tech ?? []) push(t);
  return out;
}
