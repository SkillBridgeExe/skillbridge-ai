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
