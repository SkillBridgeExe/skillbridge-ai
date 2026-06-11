import { Injectable, Logger } from '@nestjs/common';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import {
  RoleRubricService,
  RoleSkillRequirement,
  Importance,
} from '../../common/services/role-rubric.service';
import { inferSkills, loadSkillEdges, InferredSkill } from './skill-graph';
import { findSatisfying, loadSatisfiesEdges } from './skill-satisfies';

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
  skill_type: 'hard' | 'soft';
  /**
   * Canonical of the CHILD skill that satisfied this requirement via a curated
   * satisfies-edge (sql_server for sql). Absent = direct match on the requirement itself.
   */
  satisfied_by?: string;
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
  skill_type: 'hard' | 'soft';
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
   * Weighted composite with step-5 semantics (multiplier/exponent/cap values live in
   * MATCH_TUNING — the single source of truth):
   *   effective_weight = weight × importance_multiplier
   *   strength          = 1 if met · (cv/required)^exponent if below · 0 if missing
   *   raw               = Σ(eff_w × strength) / Σ(eff_w) × 100
   *   overall           = min(raw, capBase + capSlope × required_coverage)
   */
  overall_score: number;
  /** Which source the required-skills set came from (telemetry / UI honesty). */
  requirements_source: 'jd_extraction' | 'role_rubric' | 'none';
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
  /** Display-only Inferred-layer suggestions (skill-graph). NEVER affects any score. */
  inferred_skills?: InferredSkill[];
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
 *   2. Build "required_skills" set: a provided JD (jd_requirements_raw) takes PRECEDENCE;
 *      the role rubric (target_role) is the fallback when there is no usable JD.
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
    const { requirements, unnormalizedJd, source } = this.buildRequirements(args);

    // Compute diff
    const matched: MatchedSkill[] = [];
    const partial: PartialSkill[] = [];
    const missing: MissingSkill[] = [];

    const tuning = MATCH_TUNING;
    let weightSum = 0;
    let achievedWeight = 0;
    let requiredTotal = 0;
    let requiredMet = 0;

    // Children consumed as satisfies-credit — excluded from bonus to avoid double-display
    // (sql matched "via SQL Server" + SQL Server again in bonus would read as double-counting).
    const satisfiedChildren = new Set<string>();

    for (const req of requirements) {
      // Exact hit on the requirement canonical wins; only on a miss do we consult the
      // curated satisfies-edges (child counts as parent at the CHILD's own level).
      let cvHit = cvSkillsByCanonical.get(req.skill_canonical_name);
      let satisfiedBy: string | undefined;
      if (!cvHit) {
        const viaChild = findSatisfying(
          req.skill_canonical_name,
          cvSkillsByCanonical,
          loadSatisfiesEdges(),
        );
        if (viaChild) {
          cvHit = cvSkillsByCanonical.get(viaChild.child);
          satisfiedBy = viaChild.child;
          satisfiedChildren.add(viaChild.child);
        }
      }
      const displayName =
        this.normalizer.getByCanonical(req.skill_canonical_name)?.display_name ??
        req.skill_canonical_name;
      const skill_type: 'hard' | 'soft' =
        this.normalizer.getByCanonical(req.skill_canonical_name)?.category === 'soft_skill'
          ? 'soft'
          : 'hard';

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
          skill_type,
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
          skill_type,
          ...(satisfiedBy ? { satisfied_by: satisfiedBy } : {}),
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
          skill_type,
          gap_levels: req.required_level - cvHit.level,
          ...(satisfiedBy ? { satisfied_by: satisfiedBy } : {}),
        });
        achievedWeight +=
          effectiveWeight * Math.pow(cvHit.level / req.required_level, tuning.partialExponent);
      }
    }

    // Bonus skills: everything the CV has that the role doesn't ask for — surfaced, NEVER penalized.
    const requiredNames = new Set(requirements.map((r) => r.skill_canonical_name));
    const bonus: BonusSkill[] = [];
    for (const [canonical, hit] of cvSkillsByCanonical) {
      if (requiredNames.has(canonical) || satisfiedChildren.has(canonical)) continue;
      bonus.push({
        canonical_name: canonical,
        display_name: this.normalizer.getByCanonical(canonical)?.display_name ?? canonical,
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

    // Inferred layer (display-only, post-score — touches NO scoring math).
    const cvCanonicals = [...cvSkillsByCanonical.keys()];
    // Exclude skills the CV already has AND skills already named as requirements-but-missing
    // (those surface as explicit gaps in missing_skills — don't double-count them as "inferred").
    const excludeSet = new Set<string>([...cvCanonicals, ...missing.map((m) => m.canonical_name)]);
    const inferred_skills = inferSkills(
      loadSkillEdges(),
      cvCanonicals,
      args.target_role ?? null,
      excludeSet,
      (c) => this.normalizer.getByCanonical(c)?.display_name ?? c,
      'vi',
    );

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
      requirements_source: source,
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
      inferred_skills,
    };
  }

  /**
   * Build the "required skills" list.
   *   1. A provided JD that yields ≥1 normalizable requirement WINS — a pasted JD is the user
   *      explicitly asking "match me to THIS posting"; it must not be silently overridden by the
   *      generic role rubric (root cause B — 2026-06-08 match-consistency spec).
   *   2. Else fall back to the role rubric (vetted by HR) when target_role has one.
   *   3. Else empty (caller gets 0 overall_score, all-missing).
   */
  private buildRequirements(args: {
    jd_requirements_raw?: RawJdRequirement[];
    target_role?: string | null;
  }): {
    requirements: RoleSkillRequirement[];
    unnormalizedJd: UnnormalizedSkill[];
    source: 'jd_extraction' | 'role_rubric' | 'none';
  } {
    const { requirements: jdReqs, unnormalizedJd } = this.normalizeJdRequirements(
      args.jd_requirements_raw ?? [],
    );
    if (jdReqs.length > 0) {
      return { requirements: jdReqs, unnormalizedJd, source: 'jd_extraction' };
    }

    if (args.target_role) {
      const rubric = this.rubrics.getRubric(args.target_role);
      if (rubric) {
        return { requirements: rubric.skills, unnormalizedJd, source: 'role_rubric' };
      }
      this.logger.warn(
        `No rubric for target_role "${args.target_role}" and no usable JD requirements — empty requirement set.`,
      );
    }

    return { requirements: [], unnormalizedJd, source: 'none' };
  }

  /**
   * Normalize LLM-extracted JD requirements → canonical requirement list. Full stage-0
   * (normalizeMention) so a compound/umbrella JD line contributes every skill it names.
   * Equal weights over the resolved canonical set, deduped first-occurrence (first mention's
   * level/importance hints win).
   */
  private normalizeJdRequirements(raw: RawJdRequirement[]): {
    requirements: RoleSkillRequirement[];
    unnormalizedJd: UnnormalizedSkill[];
  } {
    const unnormalizedJd: UnnormalizedSkill[] = [];
    const resolved = new Map<string, { level: number; importance: Importance }>();
    for (const r of raw) {
      const results = this.normalizer
        .normalizeMention(r.name)
        .filter((n) => n.canonical_name !== null);
      if (results.length === 0) {
        unnormalizedJd.push({
          raw_input: r.name,
          evidence_text: r.evidence_text,
          reason: 'not_in_taxonomy',
        });
        continue;
      }
      for (const n of results) {
        const canonical = n.canonical_name as string;
        if (!resolved.has(canonical)) {
          resolved.set(canonical, {
            level: this.proficiencyToLevel(r.required_level_hint),
            importance: this.toImportance(r.importance_hint),
          });
        }
      }
    }
    // Skill-type weighting (JD-extraction path only): specialized (hard) skills weigh more than
    // common (soft) ones, instead of pure equal-weight. Normalized so weights sum ~1 (keeps
    // overall_score on its 0-100 scale). Rubric path is untouched (curated weights).
    const TYPE_WEIGHT = { hard: 1, soft: 0.5 } as const;
    const based = [...resolved.entries()].map(([canonical, meta]) => ({
      canonical,
      meta,
      base:
        this.normalizer.getByCanonical(canonical)?.category === 'soft_skill'
          ? TYPE_WEIGHT.soft
          : TYPE_WEIGHT.hard,
    }));
    const totalBase = based.reduce((s, b) => s + b.base, 0);
    const requirements: RoleSkillRequirement[] = based.map(({ canonical, meta, base }) => ({
      skill_canonical_name: canonical,
      required_level: meta.level,
      importance: meta.importance,
      weight: totalBase > 0 ? round3(base / totalBase) : 0,
    }));
    return { requirements, unnormalizedJd };
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
