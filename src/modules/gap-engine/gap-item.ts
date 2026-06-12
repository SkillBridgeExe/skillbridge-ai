/**
 * Unified Gap Engine v2 — FOUNDATION (PR1).
 *
 * One canonical "gap object" that every CV-analysis flow can speak. This file is the central
 * CONTRACT: a deterministic `GapItem` type + a PURE `buildGapItems()` that UNIFIES signals that
 * already exist (SkillDiffService matched/partial/missing + the evidence ledger + optional market
 * demand) into a single list. No LLM, no Date.now/random — same input → same output.
 *
 * Deferred to later PRs (see plan): the full severity FORMULA (PR2), JD-Intelligence requirement
 * types beyond skills (PR3), the CV Patch Engine consuming `fixability` (PR4), market hardening
 * (PR5), and LLM prose for `recommended_next_action` (the current value is a deterministic label).
 */
import { EvidenceLedger } from '../../common/services/evidence-ledger';
import { Importance } from '../../common/services/role-rubric.service';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { MATCH_TUNING } from '../cv-jd-match/skill-diff.service';

export type GapSource = 'jd' | 'role_rubric' | 'market_implied';
export type GapType =
  | 'hard_skill'
  | 'soft_skill'
  | 'seniority'
  | 'language'
  | 'domain'
  | 'education'
  | 'work_mode';
export type GapImportance = Importance; // 'REQUIRED' | 'PREFERRED' | 'NICE_TO_HAVE'
export type CvStatus = 'matched' | 'partial' | 'missing' | 'unproven' | 'overclaimed';
export type EvidenceRisk = 'none' | 'listed_only' | 'unproven';
export type Fixability = 'rewrite' | 'add_evidence' | 'learn' | 'not_fixable_now';

export interface GapItem {
  /** STABLE id `${source}:${type}:${canonical_name}` — lets downstream dedupe + track a gap across re-grades. */
  requirement_id: string;
  source: GapSource;
  /** PR1 emits hard_skill/soft_skill only; JD-Intelligence v2 (PR3) adds the rest. */
  type: GapType;
  canonical_name: string;
  display_name: string;
  importance: GapImportance;
  cv_status: CvStatus;
  cv_level: number | null;
  required_level: number | null;
  /** max(0, required_level - cv_level). */
  gap_levels: number;
  /** Child skill that satisfied the requirement via a satisfies-edge (skill-diff). */
  satisfied_by: string | null;
  /** Where in the CV this skill is evidenced (ledger source refs). */
  evidence_refs: string[];
  evidence_risk: EvidenceRisk;
  fixability: Fixability;
  /** pct_of_postings (0-100) when market data is supplied; null otherwise (PR1 default). */
  market_demand: number | null;
  /** 0-1 BASELINE (importance × normalised gap). PR2 replaces with the full severity formula. */
  severity: number;
  /** 0-1. 1.0 for deterministic skill-diff items; lower reserved for market_implied (PR3+). */
  confidence: number;
  /** Deterministic short label (PR1). LLM prose is a later PR. '' when no action (a strength). */
  recommended_next_action: string;
}

export interface BuildGapItemsInput {
  match: CvJdMatchParsedResponse;
  ledger?: EvidenceLedger | null;
  /** canonical_name → pct_of_postings (0-100). Optional; PR1 callers may omit. */
  marketDemand?: Map<string, number> | null;
}

const importanceWeight = (importance: GapImportance): number =>
  MATCH_TUNING.importanceMultiplier[importance] ?? 0.3;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Baseline only (PR2 swaps in importance × gap_level × market_demand × evidence_risk × interview_risk). */
function baselineSeverity(
  importance: GapImportance,
  gapLevels: number,
  evidenceRisk: EvidenceRisk,
): number {
  const w = importanceWeight(importance);
  if (gapLevels > 0) return clamp01(w * (gapLevels / 5));
  // Level is met but evidence is weak/absent — a real (smaller) gap; fixed baseline until PR2.
  if (evidenceRisk !== 'none') return clamp01(w * 0.4);
  return 0;
}

const ACTION_LABEL: Record<CvStatus, string> = {
  missing: 'Học & bổ sung kỹ năng này',
  partial: 'Nâng trình độ và làm rõ bằng chứng',
  unproven: 'Thêm 1 bullet chứng minh (hiện chỉ liệt kê)',
  overclaimed: 'Bổ sung bằng chứng cho mức đã khai',
  matched: '',
};

const typeOf = (skillType?: 'hard' | 'soft'): GapType =>
  skillType === 'soft' ? 'soft_skill' : 'hard_skill';

/**
 * Deterministic unification of the existing diff + ledger (+ optional market) into GapItem[].
 * One item per REQUIREMENT (matched/partial/missing); bonus_skills are extras, not requirements,
 * so they are excluded here.
 */
export function buildGapItems(input: BuildGapItemsInput): GapItem[] {
  const { match, ledger, marketDemand } = input;
  const source: GapSource = match.source_of_requirements === 'jd_extraction' ? 'jd' : 'role_rubric';

  const evidenceGap = new Set(ledger?.evidence_gap ?? []);
  const strengthByCanonical = new Map(
    (ledger?.items ?? []).map((i) => [i.skill_canonical, i.strength] as const),
  );
  const refsByCanonical = new Map(
    (ledger?.items ?? []).map((i) => [i.skill_canonical, i.sources.map((s) => s.ref)] as const),
  );

  const base = (
    canonical: string,
    displayName: string,
    importance: GapImportance,
    type: GapType,
  ) => ({
    requirement_id: `${source}:${type}:${canonical}`,
    source,
    type,
    canonical_name: canonical,
    display_name: displayName,
    importance,
    satisfied_by: null as string | null,
    evidence_refs: refsByCanonical.get(canonical) ?? [],
    market_demand: marketDemand?.get(canonical) ?? null,
    confidence: 1,
  });

  const items: GapItem[] = [];

  for (const m of match.missing_skills) {
    const evidence_risk: EvidenceRisk = 'none';
    items.push({
      ...base(m.canonical_name, m.display_name, m.importance, typeOf(m.skill_type)),
      cv_status: 'missing',
      cv_level: null,
      required_level: m.required_level,
      gap_levels: m.gap_levels,
      evidence_risk,
      fixability: 'learn',
      severity: baselineSeverity(m.importance, m.gap_levels, evidence_risk),
      recommended_next_action: ACTION_LABEL.missing,
    });
  }

  for (const p of match.partial_skills) {
    const demonstrated = strengthByCanonical.get(p.canonical_name) === 'demonstrated';
    const evidence_risk: EvidenceRisk = evidenceGap.has(p.canonical_name) ? 'listed_only' : 'none';
    items.push({
      ...base(p.canonical_name, p.display_name, p.importance, typeOf(p.skill_type)),
      satisfied_by: p.satisfied_by ?? null,
      cv_status: 'partial',
      cv_level: p.cv_level,
      required_level: p.required_level,
      gap_levels: p.gap_levels,
      evidence_risk,
      // Demonstrated → a rewrite can foreground it; otherwise the level itself must grow.
      fixability: demonstrated ? 'rewrite' : 'learn',
      severity: baselineSeverity(p.importance, p.gap_levels, evidence_risk),
      recommended_next_action: ACTION_LABEL.partial,
    });
  }

  for (const mt of match.matched_skills) {
    const strength = strengthByCanonical.get(mt.canonical_name);
    const listedOnly = evidenceGap.has(mt.canonical_name) || strength === 'listed_only';
    const overclaimed = listedOnly && mt.cv_level >= 4;
    const cv_status: CvStatus = overclaimed ? 'overclaimed' : listedOnly ? 'unproven' : 'matched';
    const evidence_risk: EvidenceRisk = overclaimed
      ? 'unproven'
      : listedOnly
        ? 'listed_only'
        : 'none';
    items.push({
      ...base(mt.canonical_name, mt.display_name, mt.importance, typeOf(mt.skill_type)),
      satisfied_by: mt.satisfied_by ?? null,
      cv_status,
      cv_level: mt.cv_level,
      required_level: mt.required_level,
      gap_levels: 0,
      evidence_risk,
      fixability: cv_status === 'matched' ? 'not_fixable_now' : 'add_evidence',
      severity: baselineSeverity(mt.importance, 0, evidence_risk),
      recommended_next_action: ACTION_LABEL[cv_status],
    });
  }

  // Highest severity first; stable tiebreak by canonical so output is reproducible.
  return items.sort(
    (a, b) => b.severity - a.severity || a.canonical_name.localeCompare(b.canonical_name),
  );
}
