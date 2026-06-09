import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import { SkillDiffService } from '../../../src/modules/cv-jd-match/skill-diff.service';
import { buildInterviewPlan } from '../../../src/modules/interview/interview-planner';

describe('buildInterviewPlan (pure)', () => {
  let diff: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diff = new SkillDiffService(normalizer, rubrics);
  });

  // Frontend CV: react matched(ADVANCED>=4), javascript partial (NOVICE 2 < required),
  // many REQUIRED missing (html, css, ...) — rich diff for selection tests.
  const richDiff = () =>
    diff.diff({
      cv_skills_raw: [
        { name: 'React', proficiency_hint: 'ADVANCED' },
        { name: 'JavaScript', proficiency_hint: 'NOVICE' },
        { name: 'Git', proficiency_hint: 'INTERMEDIATE' },
      ],
      target_role: 'frontend_developer',
    });

  it('selects ≤2 gap_probes from missing REQUIRED, sorted by weight desc, difficulty foundation', () => {
    const plan = buildInterviewPlan(richDiff(), null, null, 'vi');
    const gaps = plan.filter((p) => p.focus_type === 'gap_probe');
    expect(gaps.length).toBeLessThanOrEqual(2);
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) expect(g.difficulty).toBe('foundation');
    // weight-desc: the first gap_probe is the heaviest missing REQUIRED in the rubric
    const d = richDiff();
    const missingReq = d.missing_skills
      .filter((m) => m.importance === 'REQUIRED')
      .sort((a, b) => b.weight - a.weight);
    expect(gaps[0].skill_canonical).toBe(missingReq[0].canonical_name);
  });

  it('selects depth_probes from partial skills with level-aware difficulty', () => {
    const plan = buildInterviewPlan(richDiff(), null, null, 'vi');
    const depths = plan.filter((p) => p.focus_type === 'depth_probe');
    expect(depths.length).toBeGreaterThan(0);
    expect(depths.length).toBeLessThanOrEqual(2);
    const d = richDiff();
    for (const dp of depths) {
      const partial = d.partial_skills.find((s) => s.canonical_name === dp.skill_canonical)!;
      expect(dp.difficulty).toBe(partial.gap_levels >= 2 ? 'foundation' : 'applied');
    }
  });

  it('evidence_probe only for matched∩evidenceGap, and skipped entirely when evidenceGap is null', () => {
    const withNull = buildInterviewPlan(richDiff(), null, null, 'vi');
    expect(withNull.some((p) => p.focus_type === 'evidence_probe')).toBe(false);
    // react is MATCHED and in the evidence gap → evidence_probe; javascript is PARTIAL → must NOT
    const withGap = buildInterviewPlan(richDiff(), ['react', 'javascript'], null, 'vi');
    const ev = withGap.filter((p) => p.focus_type === 'evidence_probe');
    expect(ev.map((e) => e.skill_canonical)).toEqual(['react']);
  });

  it('each skill appears at most once across the whole plan', () => {
    const plan = buildInterviewPlan(richDiff(), ['react'], new Set(['react']), 'vi');
    const canonicals = plan.map((p) => p.skill_canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  it('strength_showcase: exactly one, prefers matched∩demonstrated', () => {
    const plan = buildInterviewPlan(richDiff(), null, new Set(['react']), 'vi');
    const sh = plan.filter((p) => p.focus_type === 'strength_showcase');
    expect(sh).toHaveLength(1);
    expect(sh[0].skill_canonical).toBe('react');
    expect(sh[0].difficulty).toBe('applied');
  });

  it('caps the total at 7 (≤6 probes + 1 showcase)', () => {
    const plan = buildInterviewPlan(richDiff(), ['react'], new Set(['react']), 'vi');
    expect(plan.length).toBeLessThanOrEqual(7);
  });

  it('returns [] for an empty diff (no requirements at all)', () => {
    const empty = diff.diff({ cv_skills_raw: [], jd_requirements_raw: [], target_role: null });
    expect(buildInterviewPlan(empty, null, null, 'vi')).toEqual([]);
  });

  it('vi and en templates are interpolated and non-empty, reason always present', () => {
    for (const lang of ['vi', 'en'] as const) {
      const plan = buildInterviewPlan(richDiff(), ['react'], new Set(['react']), lang);
      for (const p of plan) {
        expect(p.reason.length).toBeGreaterThan(0);
        expect(p.template_question).toContain(p.display_name);
      }
    }
  });
});
