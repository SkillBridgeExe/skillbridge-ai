import { Injectable, Logger } from '@nestjs/common';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import {
  RoleRubricService,
  RoleSkillRequirement,
  Importance,
} from '../../common/services/role-rubric.service';

export type ProficiencyHint = 'BEGINNER' | 'NOVICE' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';

/** LLM-extracted raw skill from cv_jd_match_v1 prompt output. */
export interface RawCvSkill {
  name: string;
  evidence_text?: string;
  proficiency_hint?: ProficiencyHint | string;
}

/** LLM-extracted raw requirement from JD. */
export interface RawJdRequirement {
  name: string;
  required_level_hint?: ProficiencyHint | string;
  importance_hint?: Importance | string;
  evidence_text?: string;
}

export interface MatchedSkill {
  skill_id: string;
  canonical_name: string;
  display_name: string;
  cv_level: number;
  required_level: number;
  importance: Importance;
  weight: number;
}

export interface PartialSkill extends MatchedSkill {
  /** required_level - cv_level. Positive number indicates the gap. */
  gap_levels: number;
}

export interface MissingSkill {
  skill_id: string;
  canonical_name: string;
  display_name: string;
  required_level: number;
  importance: Importance;
  weight: number;
  /** required_level - 0. Always equals required_level (kept for symmetry with PartialSkill). */
  gap_levels: number;
}

export interface UnnormalizedSkill {
  raw_input: string;
  evidence_text?: string;
  /** Why we couldn't normalize: not in taxonomy. */
  reason: 'not_in_taxonomy';
}

/** CV skill the role does NOT require — surfaced for the UI, NEVER penalized. */
export interface BonusSkill {
  canonical_name: string;
  display_name: string;
  cv_level: number;
}

/**
 * Step-5 scoring tunables (blueprint matching_plan). Exported so the calibration sweep can
 * exercise variants; the shipped values are the ones that put eval-match pairs in-band.
 */
export interface MatchTuning {
  /** Importance is MATHEMATICAL, not just a UI label: effective_weight = weight × multiplier. */
  importanceMultiplier: Record<Importance, number>;
  /** Partial credit is CONVEX: strength = (cv_level/required_level)^exponent — a junior-everywhere
   *  CV no longer harvests near-linear credit (eval edge-levelgap/keyword-stuffing pairs). */
  partialExponent: number;
  /** Soft cap: overall ≤ capBase + capSlope × required_coverage. A CV missing REQUIRED skills
   *  cannot ride PREFERRED riches past the cap (eval edge-missing-required pair). */
  coverageCapBase: number;
  coverageCapSlope: number;
}

export const MATCH_TUNING: MatchTuning = {
  importanceMultiplier: { REQUIRED: 1.0, PREFERRED: 0.6, NICE_TO_HAVE: 0.3 },
  partialExponent: 1.6,
  coverageCapBase: 45,
  coverageCapSlope: 55,
};

export interface DiffResult {
  matched_skills: MatchedSkill[];
  partial_skills: PartialSkill[];
  missing_skills: MissingSkill[];
  /** CV skills the role does not require — shown as strengths, never subtracted. */
  bonus_skills: BonusSkill[];
  /** CV skills that didn't normalize to taxonomy — flagged for taxonomy expansion. */
  unnormalized_cv_skills: UnnormalizedSkill[];
  /** JD requirements that didn't normalize — same reason, flagged for review. */
  unnormalized_jd_requirements: UnnormalizedSkill[];

  /** match_ratio = matched.length / required.length × 100 (0-100). */
  match_ratio: number;
  /** Fraction of REQUIRED-importance skills met at level (0-1; 1 when the role has none). */
  required_coverage: number;
  /**
   * Weighted composite with step-5 semantics:
   *   effective_weight = weight × importance_multiplier (REQUIRED 1 / PREFERRED .5 / NICE .25)
   *   strength          = 1 if met · (cv/required)^exponent if below · 0 if missing
   *   raw               = Σ(eff_w × strength) / Σ(eff_w) × 100
   *   overall           = min(raw, capBase + capSlope × required_coverage)
   */
  overall_score: number;
  /** Breakdown for transparency / audit. */
  scoring_breakdown: {
    total_requirements: number;
    matched_count: number;
    partial_count: number;
    missing_count: number;
    weight_sum: number;
    achieved_weight: number;
    required_total: number;
    required_met: number;
    raw_weighted_score: number;
    cap_applied: boolean;
  };
}

const PROFICIENCY_TO_LEVEL: Record<ProficiencyHint, number> = {
  BEGINNER: 1,
  NOVICE: 2,
  INTERMEDIATE: 3,
  ADVANCED: 4,
  EXPERT: 5,
};

const DEFAULT_LEVEL = 3; // INTERMEDIATE — used when LLM hint is missing/invalid
const DEFAULT_IMPORTANCE: Importance = 'REQUIRED';

/**
 * Deterministic skill-gap analysis.
 *
 * Flow:
 *   1. Normalize raw CV skills + raw JD requirements via SkillNormalizerService
 *      (LLM-extracted free-text → canonical taxonomy IDs).
 *   2. Build "required_skills" set: either from role rubric (target_role) OR from
 *      JD extraction (jd_requirements_raw). Rubric takes precedence if both given.
 *   3. For each required skill: matched | partial | missing based on cv level vs required.
 *   4. Compute scores (match_ratio + weighted overall_score).
 *
 * NO LLM CALLS HERE. Pure code, fully reproducible. Same input → same output every time.
 */
@Injectable()
export class SkillDiffService {
  private readonly logger = new Logger(SkillDiffService.name);

  constructor(
    private readonly normalizer: SkillNormalizerService,
    private readonly rubrics: RoleRubricService,
  ) {}

  /**
   * Main entry point. Takes LLM-extracted raw arrays + optional target_role,
   * returns full diff with matched/missing/partial + scores.
   */
  diff(args: {
    cv_skills_raw: RawCvSkill[];
    jd_requirements_raw?: RawJdRequirement[];
    target_role?: string | null;
  }): DiffResult {
    const cvSkillsByCanonical = new Map<string, { level: number; raw: RawCvSkill }>();
    const unnormalizedCv: UnnormalizedSkill[] = [];

    // Normalize CV skills → canonical with level. normalizeMention (stage-0) lets a compound
    // entry ("React + Redux", "Lập trình web") credit EVERY skill it names.
    for (const raw of args.cv_skills_raw ?? []) {
      const results = this.normalizer
        .normalizeMention(raw.name)
        .filter((r) => r.canonical_name !== null);
      if (results.length === 0) {
        unnormalizedCv.push({
          raw_input: raw.name,
          evidence_text: raw.evidence_text,
          reason: 'not_in_taxonomy',
        });
        continue;
      }
      const level = this.proficiencyToLevel(raw.proficiency_hint);
      for (const normalized of results) {
        const canonical = normalized.canonical_name as string;
        const existing = cvSkillsByCanonical.get(canonical);
        if (!existing || level > existing.level) {
          cvSkillsByCanonical.set(canonical, { level, raw });
        }
      }
    }

    // Build required-skills list
    const { requirements, unnormalizedJd } = this.buildRequirements(args);

    // Compute diff
    const matched: MatchedSkill[] = [];
    const partial: PartialSkill[] = [];
    const missing: MissingSkill[] = [];

    const tuning = MATCH_TUNING;
    let weightSum = 0;
    let achievedWeight = 0;
    let requiredTotal = 0;
    let requiredMet = 0;

    for (const req of requirements) {
      const cvHit = cvSkillsByCanonical.get(req.skill_canonical_name);
      const displayName =
        this.normalizer
          .getTaxonomyEntries()
          .find((t) => t.canonical_name === req.skill_canonical_name)?.display_name ??
        req.skill_canonical_name;

      // Step 5: importance drives the math, not just the UI label.
      const effectiveWeight = req.weight * tuning.importanceMultiplier[req.importance];
      weightSum += effectiveWeight;
      if (req.importance === 'REQUIRED') requiredTotal += 1;

      if (!cvHit) {
        missing.push({
          skill_id: req.skill_canonical_name,
          canonical_name: req.skill_canonical_name,
          display_name: displayName,
          required_level: req.required_level,
          importance: req.importance,
          weight: req.weight,
          gap_levels: req.required_level,
        });
        // match_strength = 0, achieved_weight += 0
        continue;
      }

      if (cvHit.level >= req.required_level) {
        matched.push({
          skill_id: req.skill_canonical_name,
          canonical_name: req.skill_canonical_name,
          display_name: displayName,
          cv_level: cvHit.level,
          required_level: req.required_level,
          importance: req.importance,
          weight: req.weight,
        });
        achievedWeight += effectiveWeight;
        if (req.importance === 'REQUIRED') requiredMet += 1;
      } else {
        // Partial: CONVEX credit (cv/required)^exponent — junior-everywhere CVs no longer
        // harvest near-linear credit (eval pairs: levelgap-all-novice, keyword-stuffing).
        partial.push({
          skill_id: req.skill_canonical_name,
          canonical_name: req.skill_canonical_name,
          display_name: displayName,
          cv_level: cvHit.level,
          required_level: req.required_level,
          importance: req.importance,
          weight: req.weight,
          gap_levels: req.required_level - cvHit.level,
        });
        achievedWeight +=
          effectiveWeight * Math.pow(cvHit.level / req.required_level, tuning.partialExponent);
      }
    }

    // Bonus skills: everything the CV has that the role doesn't ask for — surfaced, NEVER penalized.
    const requiredNames = new Set(requirements.map((r) => r.skill_canonical_name));
    const bonus: BonusSkill[] = [];
    for (const [canonical, hit] of cvSkillsByCanonical) {
      if (requiredNames.has(canonical)) continue;
      const entry = this.normalizer
        .getTaxonomyEntries()
        .find((t) => t.canonical_name === canonical);
      bonus.push({
        canonical_name: canonical,
        display_name: entry?.display_name ?? canonical,
        cv_level: hit.level,
      });
    }

    const totalReqs = requirements.length;
    const match_ratio = totalReqs > 0 ? Math.round((matched.length / totalReqs) * 100) : 0;
    const required_coverage = requiredTotal > 0 ? requiredMet / requiredTotal : 1;
    const raw = weightSum > 0 ? (achievedWeight / weightSum) * 100 : 0;
    // Soft cap: PREFERRED/NICE riches cannot carry a CV past what its REQUIRED coverage supports.
    const cap = tuning.coverageCapBase + tuning.coverageCapSlope * required_coverage;
    const overall_score = Math.round(Math.min(raw, cap));

    return {
      matched_skills: matched,
      partial_skills: partial,
      missing_skills: missing,
      bonus_skills: bonus,
      unnormalized_cv_skills: unnormalizedCv,
      unnormalized_jd_requirements: unnormalizedJd,
      match_ratio,
      required_coverage: round3(required_coverage),
      overall_score,
      scoring_breakdown: {
        total_requirements: totalReqs,
        matched_count: matched.length,
        partial_count: partial.length,
        missing_count: missing.length,
        weight_sum: round3(weightSum),
        achieved_weight: round3(achievedWeight),
        required_total: requiredTotal,
        required_met: requiredMet,
        raw_weighted_score: round3(raw),
        cap_applied: cap < raw,
      },
    };
  }

  /**
   * Build the "required skills" list. Strategy:
   *   - If target_role rubric exists → use rubric (preferred — vetted by HR).
   *   - Else if jd_requirements_raw provided → normalize them, apply defaults.
   *   - Else → empty (caller gets 0 overall_score, all missing).
   *
   * Returns both the requirement list and any JD requirements that failed to normalize.
   */
  private buildRequirements(args: {
    jd_requirements_raw?: RawJdRequirement[];
    target_role?: string | null;
  }): { requirements: RoleSkillRequirement[]; unnormalizedJd: UnnormalizedSkill[] } {
    const unnormalizedJd: UnnormalizedSkill[] = [];

    if (args.target_role) {
      const rubric = this.rubrics.getRubric(args.target_role);
      if (rubric) {
        return { requirements: rubric.skills, unnormalizedJd: [] };
      }
      this.logger.warn(
        `No rubric found for target_role "${args.target_role}". Falling back to JD requirements.`,
      );
    }

    if (!args.jd_requirements_raw || args.jd_requirements_raw.length === 0) {
      return { requirements: [], unnormalizedJd: [] };
    }

    // Normalize JD requirements
    const reqs: RoleSkillRequirement[] = [];
    // Equal weight default when from JD (rubric supplies real weights).
    const equalWeight = round3(1 / args.jd_requirements_raw.length);

    for (const raw of args.jd_requirements_raw) {
      const normalized = this.normalizer.normalizeRaw(raw.name);
      if (!normalized.canonical_name) {
        unnormalizedJd.push({
          raw_input: raw.name,
          evidence_text: raw.evidence_text,
          reason: 'not_in_taxonomy',
        });
        continue;
      }
      reqs.push({
        skill_canonical_name: normalized.canonical_name,
        required_level: this.proficiencyToLevel(raw.required_level_hint),
        importance: this.toImportance(raw.importance_hint),
        weight: equalWeight,
      });
    }

    return { requirements: reqs, unnormalizedJd };
  }

  private proficiencyToLevel(hint?: string): number {
    if (!hint) return DEFAULT_LEVEL;
    const up = hint.toUpperCase() as ProficiencyHint;
    return PROFICIENCY_TO_LEVEL[up] ?? DEFAULT_LEVEL;
  }

  private toImportance(hint?: string): Importance {
    if (!hint) return DEFAULT_IMPORTANCE;
    const up = hint.toUpperCase().replace(/-/g, '_');
    if (up === 'REQUIRED' || up === 'PREFERRED' || up === 'NICE_TO_HAVE') return up;
    return DEFAULT_IMPORTANCE;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
