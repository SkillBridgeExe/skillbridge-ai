/**
 * Impact Simulator (Wave IMPACT, I1) — deterministic "what-if" score/severity payoff per
 * recommended action. Pure, no LLM, NEVER re-runs SkillDiffService.diff(): the persisted
 * matched/partial/missing arrays keep weight/importance/cv_level/required_level intact even
 * after PII masking (cv-jd-match.service.ts), so the exact scoring formula
 * (skill-diff.service.ts:269-344, tunables at MATCH_TUNING) can be MIRRORED directly from those
 * arrays. `recomputeOverall()` is that mirror — proven byte-identical against real diff() output
 * in the spec (≥3 fixtures through the REAL SkillDiffService).
 *
 * Honesty rule (constraints fact #2): missing_required / deepen_wording actually MOVE the score
 * (they change a cv_level), so their expected_impact carries {score_min, score_max}. add_evidence /
 * emphasize never change cv_level by construction — their only real payoff is a lower evidence_risk
 * → lower severity, so score stays 0-0 and severity_drop carries the number. The two shapes share
 * one interface; the field that doesn't apply is 0 (score) or null (severity_drop).
 *
 * Join responsibility: this module assumes the caller (gap-report.service.ts / unified-plan.ts)
 * already confirmed a GapItem + match-array entry exist for `action.skill_canonical` before calling
 * simulateActionImpact — an unjoined action gets NO expected_impact field at all (never a
 * fabricated 0-0). That's why the two extraction helpers below throw instead of silently
 * defaulting: a miss here means the caller's join check is wrong, not a legitimate empty case.
 */
import {
  MatchedSkill,
  PartialSkill,
  MissingSkill,
  MATCH_TUNING,
} from '../cv-jd-match/skill-diff.service';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { GapItem, EvidenceRisk, computeSeverity } from '../gap-engine/gap-item';
import { TailorAction } from '../cv-jd-match/tailor-checklist';

export type PersistedMatchArrays = Pick<
  CvJdMatchParsedResponse,
  'matched_skills' | 'partial_skills' | 'missing_skills'
>;

export interface ExpectedImpact {
  /** Points gained vs the baseline overall_score (recomputeOverall(match)) if the CV moves to the
   *  MIN post-fix state. 0 for add_evidence/emphasize (they never move cv_level). */
  score_min: number;
  /** Points gained at the MAX post-fix state. Always >= score_min. */
  score_max: number;
  /** Severity shed by dropping evidence_risk one notch (listed_only→none, unproven→listed_only).
   *  null for missing_required/deepen_wording — those move the score instead, not evidence_risk. */
  severity_drop: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Mirrors SkillDiffService.diff()'s scoring math EXACTLY (skill-diff.service.ts:269-344) from the
 * persisted matched/partial/missing arrays — no re-run of diff(). Proven byte-identical against
 * real diff() output in impact-simulator.spec.ts.
 */
export function recomputeOverall(arrays: PersistedMatchArrays): number {
  const tuning = MATCH_TUNING;
  let weightSum = 0;
  let achievedWeight = 0;
  let requiredTotal = 0;
  let requiredMet = 0;

  for (const m of arrays.matched_skills) {
    const eff = m.weight * tuning.importanceMultiplier[m.importance];
    weightSum += eff;
    achievedWeight += eff;
    if (m.importance === 'REQUIRED') {
      requiredTotal += 1;
      requiredMet += 1;
    }
  }
  for (const p of arrays.partial_skills) {
    const eff = p.weight * tuning.importanceMultiplier[p.importance];
    weightSum += eff;
    achievedWeight += eff * Math.pow(p.cv_level / p.required_level, tuning.partialExponent);
    if (p.importance === 'REQUIRED') requiredTotal += 1;
  }
  for (const ms of arrays.missing_skills) {
    const eff = ms.weight * tuning.importanceMultiplier[ms.importance];
    weightSum += eff;
    if (ms.importance === 'REQUIRED') requiredTotal += 1;
  }

  const requiredCoverage = requiredTotal > 0 ? requiredMet / requiredTotal : 1;
  const raw = weightSum > 0 ? (achievedWeight / weightSum) * 100 : 0;
  const cap = tuning.coverageCapBase + tuning.coverageCapSlope * requiredCoverage;
  return Math.round(Math.min(raw, cap));
}

type SkillBase = Pick<
  MissingSkill,
  | 'skill_id'
  | 'canonical_name'
  | 'display_name'
  | 'required_level'
  | 'importance'
  | 'weight'
  | 'skill_type'
>;

/** Route a hypothetical cv_level into matched (met) or partial (below bar) — mirrors diff()'s own
 *  `cvHit.level >= req.required_level` branch (skill-diff.service.ts:289) so a what-if level that
 *  happens to clear the bar lands in the SAME bucket the real diff() would put it in. */
function placeAtLevel(
  base: SkillBase,
  cvLevel: number,
): { matched?: MatchedSkill; partial?: PartialSkill } {
  if (cvLevel >= base.required_level) {
    return { matched: { ...base, cv_level: cvLevel } };
  }
  return { partial: { ...base, cv_level: cvLevel, gap_levels: base.required_level - cvLevel } };
}

/** What-if arrays with ONE missing-or-partial entry replaced by its post-fix level. */
function withSkillAtLevel(
  arrays: PersistedMatchArrays,
  canonical: string,
  fromMissing: boolean,
  cvLevel: number,
): PersistedMatchArrays {
  if (fromMissing) {
    const item = arrays.missing_skills.find((m) => m.canonical_name === canonical);
    if (!item) {
      throw new Error(
        `impact-simulator: missing_required action "${canonical}" has no matching missing_skills entry — caller must verify the join before calling simulateActionImpact`,
      );
    }
    const moved = placeAtLevel(item, cvLevel);
    return {
      matched_skills: moved.matched
        ? [...arrays.matched_skills, moved.matched]
        : arrays.matched_skills,
      partial_skills: moved.partial
        ? [...arrays.partial_skills, moved.partial]
        : arrays.partial_skills,
      missing_skills: arrays.missing_skills.filter((m) => m.canonical_name !== canonical),
    };
  }
  const item = arrays.partial_skills.find((p) => p.canonical_name === canonical);
  if (!item) {
    throw new Error(
      `impact-simulator: deepen_wording action "${canonical}" has no matching partial_skills entry — caller must verify the join before calling simulateActionImpact`,
    );
  }
  const rest = arrays.partial_skills.filter((p) => p.canonical_name !== canonical);
  const moved = placeAtLevel(item, cvLevel);
  return {
    matched_skills: moved.matched
      ? [...arrays.matched_skills, moved.matched]
      : arrays.matched_skills,
    partial_skills: moved.partial ? [...rest, moved.partial] : rest,
    missing_skills: arrays.missing_skills,
  };
}

/** One notch of evidence-risk relief: listed_only→none, unproven→listed_only. 'none' has no lower
 *  notch (stays 'none' — severity_drop naturally comes out 0, never negative). */
function lowerEvidenceRisk(risk: EvidenceRisk): EvidenceRisk {
  if (risk === 'unproven') return 'listed_only';
  if (risk === 'listed_only') return 'none';
  return 'none';
}

/**
 * Deterministic what-if impact for ONE recommended action.
 *   - missing_required / deepen_wording: recompute overall_score with the skill moved to its
 *     post-fix level (MAX = clears the bar; MIN = one level up, per the brief's exact per-type
 *     range formula) — score_min/score_max are the DELTA vs the current recomputeOverall(match)
 *     baseline; severity_drop is null (these actions don't touch evidence_risk).
 *   - add_evidence / emphasize: score_min = score_max = 0 (honest-zero — these never move cv_level);
 *     severity_drop = current severity minus severity with evidence_risk dropped one notch, using
 *     the SAME computeSeverity() gap-item.ts exports (no re-derivation of the formula).
 */
export function simulateActionImpact(
  match: PersistedMatchArrays,
  gapItem: GapItem,
  action: TailorAction,
): ExpectedImpact {
  if (action.action_type === 'add_evidence' || action.action_type === 'emphasize') {
    const lowered = lowerEvidenceRisk(gapItem.evidence_risk);
    const droppedSeverity = computeSeverity({
      importance: gapItem.importance,
      gap_levels: gapItem.gap_levels,
      evidence_risk: lowered,
      cv_status: gapItem.cv_status,
      market_demand: gapItem.market_demand,
    });
    return {
      score_min: 0,
      score_max: 0,
      severity_drop: round3(gapItem.severity - droppedSeverity),
    };
  }

  const baseline = recomputeOverall(match);

  if (action.action_type === 'missing_required') {
    const item = match.missing_skills.find((m) => m.canonical_name === action.skill_canonical);
    if (!item) {
      throw new Error(
        `simulateActionImpact: missing_required action "${action.skill_canonical}" has no matching missing_skills entry`,
      );
    }
    const maxArrays = withSkillAtLevel(match, action.skill_canonical, true, item.required_level);
    const minLevel = Math.max(1, item.required_level - 1);
    const minArrays = withSkillAtLevel(match, action.skill_canonical, true, minLevel);
    return {
      score_min: round1(recomputeOverall(minArrays) - baseline),
      score_max: round1(recomputeOverall(maxArrays) - baseline),
      severity_drop: null,
    };
  }

  // deepen_wording
  const item = match.partial_skills.find((p) => p.canonical_name === action.skill_canonical);
  if (!item) {
    throw new Error(
      `simulateActionImpact: deepen_wording action "${action.skill_canonical}" has no matching partial_skills entry`,
    );
  }
  const maxArrays = withSkillAtLevel(match, action.skill_canonical, false, item.required_level);
  const minArrays = withSkillAtLevel(match, action.skill_canonical, false, item.cv_level + 1);
  return {
    score_min: round1(recomputeOverall(minArrays) - baseline),
    score_max: round1(recomputeOverall(maxArrays) - baseline),
    severity_drop: null,
  };
}
