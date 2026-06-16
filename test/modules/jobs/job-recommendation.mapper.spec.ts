import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import { SkillDiffService } from '../../../src/modules/cv-jd-match/skill-diff.service';
import {
  buildJobRecommendation,
  rerankByExperience,
} from '../../../src/modules/jobs/reco/job-recommendation.service';
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
    // fits → recommendation_score equals the skill match_score (no seniority demotion), not severe.
    expect(rec.recommendation_score).toBe(diff.overall_score);
    expect(rec.severe_stretch).toBe(false);
    expect(rec.scoring_breakdown).toEqual(diff.scoring_breakdown);
    expect(Array.isArray(rec.partial_skills)).toBe(true);
    expect(rec.partial_skills[0]).toMatchObject({
      display_name: expect.any(String),
      gap_levels: expect.any(Number),
    });
  });

  it('includes experience_fit on the recommendation', async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    const diffSvc = new SkillDiffService(normalizer, rubrics);

    const diff = diffSvc.diff({
      cv_skills_raw: [{ name: 'React' }],
      jd_requirements_raw: [{ name: 'React', importance_hint: 'REQUIRED' }],
    });
    expect(diff.overall_score).toBeGreaterThan(0); // guard: a real match, so the demotion is observable

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
    // match_score stays the SKILL score (explainability); recommendation_score reflects the
    // severe seniority stretch (fresher → SENIOR) and severe_stretch is flagged for the FE.
    expect(rec.match_score).toBe(diff.overall_score);
    expect(rec.recommendation_score).toBeLessThan(rec.match_score);
    expect(rec.severe_stretch).toBe(true);
  });
});

describe('rerankByExperience — seniority guard', () => {
  const fit = (
    cv_seniority: ExperienceFit['cv_seniority'],
    job_level: string,
    verdict: ExperienceFit['verdict'],
  ): ExperienceFit => ({ cv_seniority, job_level, verdict, confidence: 'high' });

  it('a fresher does NOT get a high-skill SENIOR job above a fitting JUNIOR job', () => {
    // The senior job has the BETTER fused (skill+semantic) score, but it is a severe stretch.
    const fused = new Map<string, number>([
      ['senior-job', 0.033],
      ['junior-fit-job', 0.028],
    ]);
    const fitByJob = new Map<string, ExperienceFit>([
      ['senior-job', fit('fresher', 'SENIOR', 'stretch')],
      ['junior-fit-job', fit('fresher', 'JUNIOR', 'fits')],
    ]);
    const ranked = rerankByExperience(fused, fitByJob);
    expect(ranked[0][0]).toBe('junior-fit-job'); // fitting job wins despite lower skill score
    expect(ranked[1][0]).toBe('senior-job');
  });

  it('among same-fit jobs the skill (RRF) order is preserved', () => {
    const fused = new Map<string, number>([
      ['a', 0.03],
      ['b', 0.028],
    ]);
    const fitByJob = new Map<string, ExperienceFit>([
      ['a', fit('mid', 'MIDDLE', 'fits')],
      ['b', fit('mid', 'MIDDLE', 'fits')],
    ]);
    const ranked = rerankByExperience(fused, fitByJob);
    expect(ranked.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('unknown seniority is not demoted (ranks by skill)', () => {
    const fused = new Map<string, number>([
      ['unknown-job', 0.03],
      ['fit-job', 0.028],
    ]);
    const fitByJob = new Map<string, ExperienceFit>([
      [
        'unknown-job',
        { cv_seniority: 'mid', job_level: null, verdict: 'unknown', confidence: 'low' },
      ],
      ['fit-job', fit('mid', 'MIDDLE', 'fits')],
    ]);
    const ranked = rerankByExperience(fused, fitByJob);
    expect(ranked[0][0]).toBe('unknown-job'); // higher skill, no seniority penalty
  });
});
