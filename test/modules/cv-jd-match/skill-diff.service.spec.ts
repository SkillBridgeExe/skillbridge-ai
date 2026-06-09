import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import {
  SkillDiffService,
  MATCH_TUNING,
  RawCvSkill,
} from '../../../src/modules/cv-jd-match/skill-diff.service';

/**
 * Step-5 formula anchors — offline, real taxonomy + rubrics from data/.
 * The 14-pair gate (pnpm eval:match) owns band-accuracy; this spec pins the FORMULA MECHANICS
 * so a refactor can't silently change semantics.
 */
describe('SkillDiffService step-5 formula', () => {
  let diff: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diff = new SkillDiffService(normalizer, rubrics);
  });

  const cv = (skills: Array<[string, string]>): RawCvSkill[] =>
    skills.map(([name, hint]) => ({ name, proficiency_hint: hint }));

  it('importance multipliers shrink PREFERRED/NICE weights (missing a PREFERRED hurts less than its raw weight)', () => {
    // qa_tester: drop ONLY the PREFERRED database_testing vs dropping the REQUIRED api_testing
    // (similar raw weights 0.10 vs 0.12) — the REQUIRED loss must cost noticeably more.
    const base: Array<[string, string]> = [
      ['Manual testing', 'ADVANCED'],
      ['Selenium', 'INTERMEDIATE'],
      ['Jira', 'INTERMEDIATE'],
      ['Postman', 'INTERMEDIATE'],
      ['SQL', 'INTERMEDIATE'],
      ['Problem solving', 'ADVANCED'],
      ['Scrum', 'NOVICE'],
      ['Communication', 'INTERMEDIATE'],
      ['Git', 'NOVICE'],
      ['IELTS', 'INTERMEDIATE'],
    ];
    const full = diff.diff({
      cv_skills_raw: cv([...base, ['Database testing', 'INTERMEDIATE']]),
      target_role: 'qa_tester',
    });
    const noPreferred = diff.diff({ cv_skills_raw: cv(base), target_role: 'qa_tester' });
    const noRequired = diff.diff({
      cv_skills_raw: cv([
        ...base.filter(([n]) => n !== 'Postman'),
        ['Database testing', 'INTERMEDIATE'],
      ]),
      target_role: 'qa_tester',
    });
    expect(full.overall_score).toBeGreaterThan(noPreferred.overall_score);
    expect(noPreferred.overall_score - noRequired.overall_score).toBeGreaterThanOrEqual(2);
  });

  it('partial credit is convex: NOVICE-everywhere scores far below linear credit', () => {
    const res = diff.diff({
      cv_skills_raw: cv([
        ['HTML', 'NOVICE'],
        ['CSS', 'NOVICE'],
        ['JavaScript', 'NOVICE'],
        ['TypeScript', 'NOVICE'],
        ['React', 'NOVICE'],
        ['Responsive design', 'NOVICE'],
        ['Git', 'NOVICE'],
        ['Communication', 'NOVICE'],
        ['Web performance', 'NOVICE'],
        ['a11y', 'NOVICE'],
        ['Jest', 'NOVICE'],
        ['Next.js', 'NOVICE'],
      ]),
      target_role: 'frontend_developer',
    });
    // linear credit would be ~60+; convex + cap keeps a junior-everywhere CV in the 40s
    expect(res.overall_score).toBeLessThan(60);
    expect(res.overall_score).toBeGreaterThanOrEqual(40);
  });

  it('coverage cap binds when ALL REQUIRED skills are missing despite rich PREFERRED', () => {
    const res = diff.diff({
      cv_skills_raw: cv([
        ['Python', 'ADVANCED'],
        ['Pandas', 'ADVANCED'],
        ['Tableau', 'ADVANCED'],
        ['Power BI', 'ADVANCED'],
      ]),
      target_role: 'data_analyst',
    });
    expect(res.required_coverage).toBe(0);
    expect(res.overall_score).toBeLessThanOrEqual(MATCH_TUNING.coverageCapBase);
  });

  it('cap never blocks a perfect CV (base + slope = 100)', () => {
    expect(MATCH_TUNING.coverageCapBase + MATCH_TUNING.coverageCapSlope).toBe(100);
  });

  it('bonus skills are surfaced and never reduce the score', () => {
    const base: Array<[string, string]> = [
      ['SQL', 'ADVANCED'],
      ['Excel', 'ADVANCED'],
      ['Statistics', 'INTERMEDIATE'],
      ['Data visualization', 'INTERMEDIATE'],
      ['Communication', 'ADVANCED'],
      ['Problem solving', 'ADVANCED'],
      ['Critical thinking', 'INTERMEDIATE'],
    ];
    const plain = diff.diff({ cv_skills_raw: cv(base), target_role: 'data_analyst' });
    const withBonus = diff.diff({
      cv_skills_raw: cv([...base, ['Docker', 'ADVANCED'], ['Unity', 'ADVANCED']]),
      target_role: 'data_analyst',
    });
    expect(withBonus.overall_score).toBeGreaterThanOrEqual(plain.overall_score);
    expect(withBonus.bonus_skills.map((b) => b.canonical_name)).toEqual(
      expect.arrayContaining(['docker', 'unity']),
    );
  });

  it('compound CV entries credit every named skill ("React + Redux")', () => {
    const res = diff.diff({
      cv_skills_raw: cv([['React + Redux', 'ADVANCED']]),
      target_role: 'frontend_developer',
    });
    const names = [...res.matched_skills, ...res.partial_skills].map((s) => s.canonical_name);
    expect(names).toContain('react');
    expect(res.bonus_skills.map((b) => b.canonical_name)).toContain('redux');
  });
});

describe('SkillDiffService — JD vs rubric precedence', () => {
  let diff: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diff = new SkillDiffService(normalizer, rubrics);
  });

  it('uses the JD requirements (not the role rubric) when both a JD and target_role are given', () => {
    const res = diff.diff({
      cv_skills_raw: [{ name: 'ReactJS' }, { name: 'Git' }],
      jd_requirements_raw: [
        { name: 'React', importance_hint: 'REQUIRED' },
        { name: 'Git', importance_hint: 'REQUIRED' },
      ],
      target_role: 'frontend_developer', // rubric has 12 skills — must NOT be used here
    });

    // The JD lists 2 skills; the frontend rubric lists 12. The JD must win.
    expect(res.scoring_breakdown.total_requirements).toBe(2);
    const reqNames = [...res.matched_skills, ...res.partial_skills, ...res.missing_skills]
      .map((s) => s.canonical_name)
      .sort();
    expect(reqNames).toEqual(['git', 'react']);
  });

  it('reports requirements_source = jd_extraction when the JD wins', () => {
    const res = diff.diff({
      cv_skills_raw: [{ name: 'ReactJS' }],
      jd_requirements_raw: [{ name: 'React', importance_hint: 'REQUIRED' }],
      target_role: 'frontend_developer',
    });
    expect(res.requirements_source).toBe('jd_extraction');
  });

  it('falls back to the role rubric when the JD normalizes to zero requirements', () => {
    const res = diff.diff({
      cv_skills_raw: [{ name: 'ReactJS' }],
      jd_requirements_raw: [{ name: 'zzz-not-a-real-skill-xyz' }],
      target_role: 'frontend_developer',
    });
    expect(res.requirements_source).toBe('role_rubric');
    expect(res.scoring_breakdown.total_requirements).toBe(12); // frontend rubric size
    expect(res.unnormalized_jd_requirements.map((u) => u.raw_input)).toContain(
      'zzz-not-a-real-skill-xyz',
    );
  });

  it('still uses the rubric when no JD is provided (regression)', () => {
    const res = diff.diff({
      cv_skills_raw: [{ name: 'ReactJS' }],
      target_role: 'frontend_developer',
    });
    expect(res.requirements_source).toBe('role_rubric');
    expect(res.scoring_breakdown.total_requirements).toBe(12);
  });

  it('tags each requirement skill as hard or soft (skill_type)', () => {
    const res = diff.diff({
      cv_skills_raw: [{ name: 'React', proficiency_hint: 'ADVANCED' }],
      target_role: 'frontend_developer',
    });
    const all = [...res.matched_skills, ...res.partial_skills, ...res.missing_skills];
    const react = all.find((s) => s.canonical_name === 'react');
    const comm = all.find((s) => s.canonical_name === 'communication');
    expect(react?.skill_type).toBe('hard'); // category frontend_framework
    expect(comm?.skill_type).toBe('soft'); // category soft_skill
  });

  it('weights a specialized (hard) JD skill above a common (soft) one', () => {
    const res = diff.diff({
      cv_skills_raw: [], // both missing → both appear in missing_skills with their weights
      jd_requirements_raw: [
        { name: 'React', importance_hint: 'REQUIRED' },
        { name: 'Communication', importance_hint: 'REQUIRED' },
      ],
    });
    const react = res.missing_skills.find((s) => s.canonical_name === 'react');
    const comm = res.missing_skills.find((s) => s.canonical_name === 'communication');
    expect(react).toBeDefined();
    expect(comm).toBeDefined();
    expect(react!.weight).toBeGreaterThan(comm!.weight);
  });
});

describe('SkillDiffService — inferred_skills (display-only Inferred layer)', () => {
  let diff: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diff = new SkillDiffService(normalizer, rubrics);
  });

  it('infers an ecosystem skill the JD does not name (JS → React), not re-suggesting CV skills', () => {
    // JD requires only javascript (CV has it → matched, nothing missing). React is NOT a named
    // requirement, so it surfaces as an Inferred suggestion — the "JD needs JS, infer React" case.
    const res = diff.diff({
      cv_skills_raw: [{ name: 'JavaScript', proficiency_hint: 'ADVANCED' }],
      jd_requirements_raw: [{ name: 'JavaScript', importance_hint: 'REQUIRED' }],
      target_role: 'frontend_developer',
    });
    const inferred = res.inferred_skills?.map((s) => s.canonical_name) ?? [];
    expect(inferred).toContain('react');
    const react = res.inferred_skills!.find((s) => s.canonical_name === 'react')!;
    expect(react.inferred_from).toBe('javascript');
    expect(react.confidence).toBeGreaterThanOrEqual(0.5);
    expect(react.reason.length).toBeGreaterThan(0);
    // never re-suggests a skill the CV already has
    expect(inferred).not.toContain('javascript');
  });

  it('does NOT double-count: a required-but-missing skill stays a gap, not an inferred suggestion', () => {
    // rubric path: react is REQUIRED for frontend_developer, so a JS-only CV is MISSING react.
    // It must appear as the explicit gap, and NOT also as a soft inferred suggestion.
    const res = diff.diff({
      cv_skills_raw: [{ name: 'JavaScript', proficiency_hint: 'ADVANCED' }],
      target_role: 'frontend_developer',
    });
    const missing = res.missing_skills.map((s) => s.canonical_name);
    const inferred = res.inferred_skills?.map((s) => s.canonical_name) ?? [];
    expect(missing).toContain('react'); // the explicit gap (REQUIRED, weight 0.18)
    expect(inferred).not.toContain('react'); // ...so not double-counted as inferred
    // overall_score stays a sane number (X1-safe; the eval:match 0-drift gate is the full proof)
    expect(typeof res.overall_score).toBe('number');
  });
});
