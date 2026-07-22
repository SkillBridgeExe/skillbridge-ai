/**
 * FAIL-CLOSED DEFAULT (bug hunt 2026-07-22, #1) — a CV skill listed with NO proficiency
 * hint must NOT trivially satisfy an equal-level requirement. Before the fix both sides
 * defaulted to INTERMEDIATE(3), so a bare "PHP" on the CV met a bare "PHP" requirement at
 * strength 1 (the silent-inflation lever behind the prod 100-vs-45 split on the no-review
 * path, where the parity layer can't reconcile against a stored review). A listed-but-
 * unproven skill is graded NOVICE(2) — the same level a stored review assigns unproven
 * skills — so it lands as a PARTIAL, not a full match. Real taxonomy, no DB, no LLM.
 */
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';
import { SkillDiffService } from './skill-diff.service';

describe('proficiency default is fail-closed for unproven CV skills', () => {
  let diffSvc: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diffSvc = new SkillDiffService(normalizer, rubrics);
  });

  it('an unproven CV skill (no hint) is a PARTIAL, not a full match, on an equal-level requirement', () => {
    const out = diffSvc.diff({
      cv_skills_raw: [{ name: 'PHP' }], // no proficiency_hint → unproven
      jd_requirements_raw: [{ name: 'PHP', importance_hint: 'REQUIRED' }], // no required_level_hint → default 3
    });
    expect(out.matched_skills).toHaveLength(0);
    expect(out.partial_skills).toHaveLength(1);
    expect(out.overall_score).not.toBeNull();
    expect(out.overall_score!).toBeLessThan(100);
  });

  it('an EXPLICIT hint still wins — a stated ADVANCED CV skill fully matches a default-level requirement', () => {
    const out = diffSvc.diff({
      cv_skills_raw: [{ name: 'PHP', proficiency_hint: 'ADVANCED' }], // level 4
      jd_requirements_raw: [{ name: 'PHP', importance_hint: 'REQUIRED' }], // default 3
    });
    expect(out.matched_skills).toHaveLength(1);
    expect(out.overall_score).toBe(100);
  });

  it('an unproven CV skill still fully matches a LOW (NOVICE) explicit requirement', () => {
    const out = diffSvc.diff({
      cv_skills_raw: [{ name: 'PHP' }], // unproven → NOVICE(2)
      jd_requirements_raw: [{ name: 'PHP', importance_hint: 'REQUIRED', required_level_hint: 'NOVICE' }],
    });
    expect(out.matched_skills).toHaveLength(1);
  });
});
