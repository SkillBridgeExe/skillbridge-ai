import { SkillTrendsResponse } from './skill-demand.service';
import { TrendsInsightFacts } from './trends-insight.types';

/**
 * Distill the deterministic trends response into FACTS. `coveredCanonicals` = the CV's
 * skill set (null ⇒ role-level, no CV). FACTS are the ONLY numbers that reach the response.
 */
export function buildFacts(
  trends: SkillTrendsResponse,
  coveredCanonicals: Set<string> | null,
): TrendsInsightFacts {
  return {
    role_code: trends.role_code,
    period: trends.period,
    total_active_jobs: trends.total_active_jobs,
    personalized: coveredCanonicals !== null,
    skills: trends.skills.map((s) => ({
      skill: s.canonical_name,
      display_name: s.display_name,
      pct_of_postings: s.pct_of_postings,
      trend_delta: s.trend_delta,
      salary_p50_vnd: s.salary_p50_vnd,
      covered: coveredCanonicals ? coveredCanonicals.has(s.canonical_name) : null,
    })),
  };
}
