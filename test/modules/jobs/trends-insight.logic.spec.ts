import { buildFacts } from '../../../src/modules/jobs/trends/trends-insight.logic';
import { SkillTrendsResponse } from '../../../src/modules/jobs/trends/skill-demand.service';

const TRENDS: SkillTrendsResponse = {
  role_code: 'backend_developer',
  period: '2026-06-07',
  total_active_jobs: 200,
  skills: [
    { canonical_name: 'security', display_name: 'Security', posting_count: 78, pct_of_postings: 39.3, salary_p50_vnd: 28000000, trend_delta: 2 },
    { canonical_name: 'python', display_name: 'Python', posting_count: 54, pct_of_postings: 27.0, salary_p50_vnd: 25000000, trend_delta: 0 },
  ],
};

describe('buildFacts', () => {
  it('role-level (no CV): covered is null on every skill', () => {
    const f = buildFacts(TRENDS, null);
    expect(f.personalized).toBe(false);
    expect(f.role_code).toBe('backend_developer');
    expect(f.total_active_jobs).toBe(200);
    expect(f.skills.map((s) => s.covered)).toEqual([null, null]);
    expect(f.skills[0]).toMatchObject({ skill: 'security', pct_of_postings: 39.3, trend_delta: 2 });
  });

  it('personalized: covered reflects the CV skill set', () => {
    const f = buildFacts(TRENDS, new Set(['python']));
    expect(f.personalized).toBe(true);
    expect(f.skills.find((s) => s.skill === 'security')!.covered).toBe(false);
    expect(f.skills.find((s) => s.skill === 'python')!.covered).toBe(true);
  });
});
