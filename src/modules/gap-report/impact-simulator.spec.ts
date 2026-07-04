import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { SkillDiffService, RawCvSkill, RawJdRequirement } from '../cv-jd-match/skill-diff.service';
import { GapItem, computeSeverity } from '../gap-engine/gap-item';
import { TailorAction } from '../cv-jd-match/tailor-checklist';
import { recomputeOverall, simulateActionImpact, PersistedMatchArrays } from './impact-simulator';

/**
 * recompute-mirror proof: recomputeOverall() must reproduce SkillDiffService.diff()'s
 * overall_score EXACTLY from the persisted matched/partial/missing arrays, with zero deviation —
 * that's what lets the impact simulator skip re-running diff() entirely (constraints fact #1).
 */
describe('impact-simulator', () => {
  let diffSvc: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diffSvc = new SkillDiffService(normalizer, rubrics);
  });

  function realDiff(cv: RawCvSkill[], jd: RawJdRequirement[]) {
    const res = diffSvc.diff({ cv_skills_raw: cv, jd_requirements_raw: jd });
    expect(res.unnormalized_cv_skills).toEqual([]);
    expect(res.unnormalized_jd_requirements).toEqual([]);
    return res;
  }

  describe('recomputeOverall mirrors real SkillDiffService.diff() exactly', () => {
    it('mixed matched + partial + missing across REQUIRED/PREFERRED/NICE_TO_HAVE', () => {
      const res = realDiff(
        [
          { name: 'Git', proficiency_hint: 'ADVANCED' },
          { name: 'SQL', proficiency_hint: 'INTERMEDIATE' },
          { name: 'React', proficiency_hint: 'NOVICE' },
        ],
        [
          { name: 'Git', importance_hint: 'REQUIRED', required_level_hint: 'ADVANCED' },
          { name: 'Docker', importance_hint: 'REQUIRED', required_level_hint: 'EXPERT' },
          { name: 'SQL', importance_hint: 'PREFERRED', required_level_hint: 'EXPERT' },
          { name: 'React', importance_hint: 'NICE_TO_HAVE', required_level_hint: 'ADVANCED' },
        ],
      );
      // Sanity: the fixture actually exercises all three buckets.
      expect(res.matched_skills.length).toBe(1);
      expect(res.partial_skills.length).toBe(2);
      expect(res.missing_skills.length).toBe(1);

      const mirrored = recomputeOverall({
        matched_skills: res.matched_skills,
        partial_skills: res.partial_skills,
        missing_skills: res.missing_skills,
      });
      expect(mirrored).toBe(res.overall_score);
    });

    it('all-matched (raw hits the cap ceiling)', () => {
      const res = realDiff(
        [
          { name: 'Python', proficiency_hint: 'EXPERT' },
          { name: 'Java', proficiency_hint: 'ADVANCED' },
        ],
        [
          { name: 'Python', importance_hint: 'REQUIRED', required_level_hint: 'EXPERT' },
          { name: 'Java', importance_hint: 'PREFERRED', required_level_hint: 'ADVANCED' },
        ],
      );
      expect(res.missing_skills.length).toBe(0);
      expect(res.partial_skills.length).toBe(0);

      const mirrored = recomputeOverall({
        matched_skills: res.matched_skills,
        partial_skills: res.partial_skills,
        missing_skills: res.missing_skills,
      });
      expect(mirrored).toBe(res.overall_score);
    });

    it('all-missing (empty CV)', () => {
      const res = realDiff(
        [],
        [
          { name: 'Docker', importance_hint: 'REQUIRED', required_level_hint: 'EXPERT' },
          { name: 'Kubernetes', importance_hint: 'PREFERRED', required_level_hint: 'ADVANCED' },
        ],
      );
      expect(res.matched_skills.length).toBe(0);
      expect(res.partial_skills.length).toBe(0);
      expect(res.missing_skills.length).toBe(2);

      const mirrored = recomputeOverall({
        matched_skills: res.matched_skills,
        partial_skills: res.partial_skills,
        missing_skills: res.missing_skills,
      });
      expect(mirrored).toBe(res.overall_score);
    });
  });

  // ── simulateActionImpact: score-moving actions (missing_required / deepen_wording) ───────────

  const baseGap: GapItem = {
    requirement_id: 'jd:hard_skill:x',
    source: 'jd',
    type: 'hard_skill',
    canonical_name: 'x',
    display_name: 'X',
    importance: 'REQUIRED',
    cv_status: 'missing',
    cv_level: null,
    required_level: 5,
    gap_levels: 5,
    satisfied_by: null,
    evidence_refs: [],
    evidence_risk: 'none',
    fixability: 'learn',
    market_demand: null,
    severity: 0.5,
    confidence: 1,
    recommended_next_action: '',
  };

  const baseAction: TailorAction = {
    action_type: 'missing_required',
    skill_canonical: 'x',
    display_name: 'X',
    why: '',
    rewrite_eligible: false,
    anchor: null,
    jd_importance: 'REQUIRED',
    jd_count: null,
    cv_count: null,
    cv_level: null,
    required_level: 5,
  };

  it('missing_required: single big-weight REQUIRED skill → max > min > 0', () => {
    const match: PersistedMatchArrays = {
      matched_skills: [],
      partial_skills: [],
      missing_skills: [
        {
          skill_id: 'x',
          canonical_name: 'x',
          display_name: 'X',
          required_level: 5,
          importance: 'REQUIRED',
          weight: 1,
          skill_type: 'hard',
          gap_levels: 5,
        },
      ],
    };
    const impact = simulateActionImpact(match, baseGap, baseAction);
    expect(impact.score_max).toBeGreaterThan(impact.score_min);
    expect(impact.score_min).toBeGreaterThan(0);
    expect(impact.severity_drop).toBeNull();
  });

  it('missing_required: required_level=1 → min=max (no lower level to partially credit)', () => {
    const match: PersistedMatchArrays = {
      matched_skills: [],
      partial_skills: [],
      missing_skills: [
        {
          skill_id: 'x',
          canonical_name: 'x',
          display_name: 'X',
          required_level: 1,
          importance: 'REQUIRED',
          weight: 1,
          skill_type: 'hard',
          gap_levels: 1,
        },
      ],
    };
    const gap = { ...baseGap, required_level: 1, gap_levels: 1 };
    const action = { ...baseAction, required_level: 1 };
    const impact = simulateActionImpact(match, gap, action);
    expect(impact.score_min).toBe(impact.score_max);
    expect(impact.score_min).toBeGreaterThan(0);
  });

  it('missing_required: cap-bound — min-case stays capped, max-case lifts the cap', () => {
    // Docker (REQUIRED, missing) is the ONLY required skill; React/SQL/Git (PREFERRED/NICE,
    // matched) inflate raw score while required_coverage stays 0 until Docker fully clears.
    const match: PersistedMatchArrays = {
      matched_skills: [
        {
          skill_id: 'react',
          canonical_name: 'react',
          display_name: 'React',
          cv_level: 4,
          required_level: 3,
          importance: 'PREFERRED',
          weight: 0.25,
          skill_type: 'hard',
        },
        {
          skill_id: 'sql',
          canonical_name: 'sql',
          display_name: 'SQL',
          cv_level: 4,
          required_level: 3,
          importance: 'PREFERRED',
          weight: 0.25,
          skill_type: 'hard',
        },
        {
          skill_id: 'git',
          canonical_name: 'git',
          display_name: 'Git',
          cv_level: 4,
          required_level: 2,
          importance: 'NICE_TO_HAVE',
          weight: 0.25,
          skill_type: 'hard',
        },
      ],
      partial_skills: [],
      missing_skills: [
        {
          skill_id: 'docker',
          canonical_name: 'docker',
          display_name: 'Docker',
          required_level: 5,
          importance: 'REQUIRED',
          weight: 0.25,
          skill_type: 'hard',
          gap_levels: 5,
        },
      ],
    };
    const gap = { ...baseGap, canonical_name: 'docker', display_name: 'Docker', required_level: 5 };
    const action = {
      ...baseAction,
      skill_canonical: 'docker',
      display_name: 'Docker',
      required_level: 5,
    };

    const baseline = recomputeOverall(match);
    expect(baseline).toBe(45); // cap binds: required_coverage=0 ⇒ cap=45, raw(60) > cap

    const impact = simulateActionImpact(match, gap, action);
    // MIN (cv_level=4, still < required 5): requiredMet stays 0 ⇒ cap stays 45 ⇒ delta capped to 0
    // even though the naive raw score jumps a lot — proves the cap is honored in the what-if.
    expect(impact.score_min).toBe(0);
    // MAX (cv_level=5=required): Docker now matched ⇒ required_coverage 1 ⇒ cap lifts to 100.
    expect(impact.score_max).toBeGreaterThan(impact.score_min);
    expect(impact.score_max).toBeGreaterThan(0);
  });

  it('deepen_wording: partial 3→4 (min) vs 3→5/matched (max), both > 0', () => {
    const match: PersistedMatchArrays = {
      matched_skills: [],
      partial_skills: [
        {
          skill_id: 'x',
          canonical_name: 'x',
          display_name: 'X',
          cv_level: 3,
          required_level: 5,
          importance: 'PREFERRED',
          weight: 1,
          skill_type: 'hard',
          gap_levels: 2,
        },
      ],
      missing_skills: [],
    };
    const gap = { ...baseGap, cv_status: 'partial' as const, cv_level: 3, gap_levels: 2 };
    const action: TailorAction = {
      ...baseAction,
      action_type: 'deepen_wording',
      cv_level: 3,
      required_level: 5,
    };
    const impact = simulateActionImpact(match, gap, action);
    expect(impact.score_max).toBeGreaterThan(impact.score_min);
    expect(impact.score_min).toBeGreaterThan(0);
    expect(impact.severity_drop).toBeNull();
  });

  // ── simulateActionImpact: honest-zero actions (add_evidence / emphasize) ──────────────────────

  it('add_evidence: score stays 0-0, severity_drop > 0 (listed_only → none)', () => {
    const gap: GapItem = {
      ...baseGap,
      cv_status: 'unproven',
      cv_level: 4,
      gap_levels: 0,
      evidence_risk: 'listed_only',
      fixability: 'add_evidence',
    };
    gap.severity = computeSeverity(gap);
    const action: TailorAction = {
      ...baseAction,
      action_type: 'add_evidence',
      cv_level: 4,
    };
    const match: PersistedMatchArrays = {
      matched_skills: [],
      partial_skills: [],
      missing_skills: [],
    };
    const impact = simulateActionImpact(match, gap, action);
    expect(impact.score_min).toBe(0);
    expect(impact.score_max).toBe(0);
    expect(impact.severity_drop).not.toBeNull();
    expect(impact.severity_drop as number).toBeGreaterThan(0);
  });

  it('emphasize: score stays 0-0, severity_drop > 0 (unproven → listed_only)', () => {
    const gap: GapItem = {
      ...baseGap,
      cv_status: 'unproven',
      cv_level: 4,
      gap_levels: 0,
      evidence_risk: 'unproven',
      fixability: 'add_evidence',
    };
    gap.severity = computeSeverity(gap);
    const action: TailorAction = {
      ...baseAction,
      action_type: 'emphasize',
      rewrite_eligible: true,
      cv_level: 4,
    };
    const match: PersistedMatchArrays = {
      matched_skills: [],
      partial_skills: [],
      missing_skills: [],
    };
    const impact = simulateActionImpact(match, gap, action);
    expect(impact.score_min).toBe(0);
    expect(impact.score_max).toBe(0);
    expect(impact.severity_drop as number).toBeGreaterThan(0);
  });

  it('add_evidence: evidence_risk already none → severity_drop = 0 (no headroom, never negative)', () => {
    const gap: GapItem = {
      ...baseGap,
      cv_status: 'matched',
      cv_level: 5,
      gap_levels: 0,
      evidence_risk: 'none',
    };
    gap.severity = computeSeverity(gap);
    const action: TailorAction = { ...baseAction, action_type: 'add_evidence', cv_level: 5 };
    const match: PersistedMatchArrays = {
      matched_skills: [],
      partial_skills: [],
      missing_skills: [],
    };
    const impact = simulateActionImpact(match, gap, action);
    expect(impact.severity_drop).toBe(0);
  });
});
