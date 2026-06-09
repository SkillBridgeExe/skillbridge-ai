import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import { SkillDiffService } from '../../../src/modules/cv-jd-match/skill-diff.service';
import { buildJobRecommendation } from '../../../src/modules/jobs/reco/job-recommendation.service';
import { ExperienceFit } from '../../../src/common/services/seniority';

describe('buildJobRecommendation', () => {
  it('exposes partial_skills + scoring_breakdown and copies the diff score', async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    const diffSvc = new SkillDiffService(normalizer, rubrics);

    // A diff where the CV under-levels a required skill → produces a partial.
    const diff = diffSvc.diff({
      cv_skills_raw: [{ name: 'React', proficiency_hint: 'BEGINNER' }],
      jd_requirements_raw: [
        { name: 'React', importance_hint: 'REQUIRED', required_level_hint: 'ADVANCED' },
      ],
    });

    const job = {
      id: 'job-1',
      title: 'FE Dev',
      company_name: 'Acme',
      location: 'HCMC',
      role_code: 'frontend_developer',
      experience_level: 'JUNIOR',
      salary_min: '1000',
      salary_max: '2000',
      currency: 'VND',
      source_url: 'https://x',
      posted_at: '2026-06-01',
      skills: [],
    };

    const rec = buildJobRecommendation(job, diff, 1, 0.5, {
      cv_seniority: 'junior',
      job_level: 'JUNIOR',
      verdict: 'fits',
      confidence: 'high',
    });

    expect(rec.match_score).toBe(diff.overall_score);
    expect(rec.scoring_breakdown).toEqual(diff.scoring_breakdown);
    expect(Array.isArray(rec.partial_skills)).toBe(true);
    expect(rec.partial_skills[0]).toMatchObject({
      display_name: expect.any(String),
      gap_levels: expect.any(Number),
    });
  });

  it('includes experience_fit on the recommendation', () => {
    const taxonomy = new SkillTaxonomyService();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    const diffSvc = new SkillDiffService(normalizer, rubrics);

    const diff = diffSvc.diff({
      cv_skills_raw: [{ name: 'React' }],
      jd_requirements_raw: [{ name: 'React', importance_hint: 'REQUIRED' }],
    });

    const job = {
      id: 'job-2',
      title: 'Senior FE Dev',
      company_name: 'Acme',
      location: 'HCMC',
      role_code: 'frontend_developer',
      experience_level: 'SENIOR',
      salary_min: '3000',
      salary_max: '5000',
      currency: 'VND',
      source_url: 'https://x',
      posted_at: '2026-06-01',
      skills: [],
    };

    const fit: ExperienceFit = {
      cv_seniority: 'fresher',
      job_level: 'SENIOR',
      verdict: 'stretch',
      confidence: 'high',
    };
    const rec = buildJobRecommendation(job, diff, 1, 0.5, fit);
    expect(rec.experience_fit).toEqual(fit);
  });
});
