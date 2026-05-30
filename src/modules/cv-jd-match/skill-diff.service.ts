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

export interface DiffResult {
  matched_skills: MatchedSkill[];
  partial_skills: PartialSkill[];
  missing_skills: MissingSkill[];
  /** CV skills that didn't normalize to taxonomy — flagged for taxonomy expansion. */
  unnormalized_cv_skills: UnnormalizedSkill[];
  /** JD requirements that didn't normalize — same reason, flagged for review. */
  unnormalized_jd_requirements: UnnormalizedSkill[];

  /** match_ratio = matched.length / required.length × 100 (0-100). */
  match_ratio: number;
  /** Weighted composite: SUM(weight × match_strength) / SUM(weight) × 100 (0-100). */
  overall_score: number;
  /** Breakdown for transparency / audit. */
  scoring_breakdown: {
    total_requirements: number;
    matched_count: number;
    partial_count: number;
    missing_count: number;
    weight_sum: number;
    achieved_weight: number;
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

    // Normalize CV skills → canonical with level
    for (const raw of args.cv_skills_raw ?? []) {
      const normalized = this.normalizer.normalizeRaw(raw.name);
      if (!normalized.canonical_name) {
        unnormalizedCv.push({
          raw_input: raw.name,
          evidence_text: raw.evidence_text,
          reason: 'not_in_taxonomy',
        });
        continue;
      }
      const level = this.proficiencyToLevel(raw.proficiency_hint);
      const existing = cvSkillsByCanonical.get(normalized.canonical_name);
      if (!existing || level > existing.level) {
        cvSkillsByCanonical.set(normalized.canonical_name, { level, raw });
      }
    }

    // Build required-skills list
    const { requirements, unnormalizedJd } = this.buildRequirements(args);

    // Compute diff
    const matched: MatchedSkill[] = [];
    const partial: PartialSkill[] = [];
    const missing: MissingSkill[] = [];

    let weightSum = 0;
    let achievedWeight = 0;

    for (const req of requirements) {
      const cvHit = cvSkillsByCanonical.get(req.skill_canonical_name);
      const displayName =
        this.normalizer
          .getTaxonomyEntries()
          .find((t) => t.canonical_name === req.skill_canonical_name)?.display_name ??
        req.skill_canonical_name;

      weightSum += req.weight;

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
        achievedWeight += req.weight * 1.0;
      } else {
        // Partial: cv_level < required_level. Strength = cv_level / required_level (proportional).
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
        achievedWeight += req.weight * (cvHit.level / req.required_level);
      }
    }

    const totalReqs = requirements.length;
    const match_ratio = totalReqs > 0 ? Math.round((matched.length / totalReqs) * 100) : 0;
    const overall_score = weightSum > 0 ? Math.round((achievedWeight / weightSum) * 100) : 0;

    return {
      matched_skills: matched,
      partial_skills: partial,
      missing_skills: missing,
      unnormalized_cv_skills: unnormalizedCv,
      unnormalized_jd_requirements: unnormalizedJd,
      match_ratio,
      overall_score,
      scoring_breakdown: {
        total_requirements: totalReqs,
        matched_count: matched.length,
        partial_count: partial.length,
        missing_count: missing.length,
        weight_sum: round3(weightSum),
        achieved_weight: round3(achievedWeight),
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
