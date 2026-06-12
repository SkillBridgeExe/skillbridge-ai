import { SkillTrendsResponse } from './skill-demand.service';
import {
  CoOccurrencePair,
  TrendsInsightFacts,
  InsightItem,
  RecommendedSkill,
  SkillPairInsight,
  TrendsInsightLlmRaw,
  TrendsInsightResponse,
} from './trends-insight.types';

/**
 * Distill the deterministic trends response into FACTS. `coveredCanonicals` = the CV's
 * skill set (null ⇒ role-level, no CV). FACTS are the ONLY numbers that reach the response.
 */
export function buildFacts(
  trends: SkillTrendsResponse,
  coveredCanonicals: Set<string> | null,
  coOccurrence: CoOccurrencePair[] = [],
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
    co_occurrence: coOccurrence,
  };
}

const TOP_N_FALLBACK = 3;
const MAX_INSIGHTS = 5;
const MAX_RECOMMENDED = 5;
const MAX_PAIRS = 4;

/** Deterministic summary built ONLY from FACTS — used as fallback and when the LLM summary is empty. */
function fallbackSummary(facts: TrendsInsightFacts): string {
  const top = facts.skills
    .slice(0, TOP_N_FALLBACK)
    .map((s) => `${s.display_name} (${s.pct_of_postings}%)`);
  const head = facts.personalized
    ? `Theo ${facts.total_active_jobs} tin tuyển dụng cho vai trò này`
    : `Top kỹ năng theo ${facts.total_active_jobs} tin tuyển dụng`;
  return top.length ? `${head}: ${top.join(', ')}.` : `${head}.`;
}

function fallback(facts: TrendsInsightFacts): TrendsInsightResponse {
  const insights: InsightItem[] = facts.skills.slice(0, TOP_N_FALLBACK).map((s) => ({
    skill: s.skill,
    display_name: s.display_name,
    pct_of_postings: s.pct_of_postings,
    trend_delta: s.trend_delta,
    covered: s.covered,
    comment: '',
  }));
  const pool = facts.personalized ? facts.skills.filter((s) => s.covered === false) : facts.skills;
  const recommended_skills: RecommendedSkill[] = pool.slice(0, MAX_RECOMMENDED).map((s) => ({
    skill: s.skill,
    display_name: s.display_name,
    pct_of_postings: s.pct_of_postings,
    salary_p50_vnd: s.salary_p50_vnd,
  }));
  return {
    role_code: facts.role_code,
    period: facts.period,
    personalized: facts.personalized,
    summary: fallbackSummary(facts),
    insights,
    recommended_skills,
    skill_pairs: [],
    cached: false,
  };
}

/**
 * The anti-hallucination boundary. The LLM output is treated as PROSE ONLY:
 *  - an insight is kept ONLY if its `skill` is in FACTS; its numbers are RE-ATTACHED from FACTS
 *    (any number the LLM emitted is discarded); the LLM `comment` text is kept (clamped).
 *  - `recommended_skills` keys must be in FACTS — and, when personalized, in the gap
 *    (covered === false). Numbers from FACTS; demand-ordered; capped.
 *  - a non-object / parse-failure → deterministic {@link fallback}.
 */
export function groundInsight(llmRaw: unknown, facts: TrendsInsightFacts): TrendsInsightResponse {
  const raw = llmRaw && typeof llmRaw === 'object' ? (llmRaw as TrendsInsightLlmRaw) : null;
  if (!raw) return fallback(facts);

  const byCanon = new Map(facts.skills.map((s) => [s.skill, s]));

  const seen = new Set<string>();
  const insights: InsightItem[] = [];
  for (const item of Array.isArray(raw.insights) ? raw.insights : []) {
    const key = typeof item?.skill === 'string' ? item.skill : '';
    const f = byCanon.get(key);
    if (!f || seen.has(key)) continue;
    seen.add(key);
    insights.push({
      skill: f.skill,
      display_name: f.display_name,
      pct_of_postings: f.pct_of_postings,
      trend_delta: f.trend_delta,
      covered: f.covered,
      comment: typeof item?.comment === 'string' ? item.comment.slice(0, 280) : '',
    });
  }

  const recPool = facts.personalized
    ? facts.skills.filter((s) => s.covered === false)
    : facts.skills;
  const recAllowed = new Map(recPool.map((s) => [s.skill, s]));
  const recSeen = new Set<string>();
  const recommended_skills: RecommendedSkill[] = [];
  for (const k of Array.isArray(raw.recommended_skills) ? raw.recommended_skills : []) {
    const key = typeof k === 'string' ? k : '';
    const f = recAllowed.get(key);
    if (!f || recSeen.has(key)) continue;
    recSeen.add(key);
    recommended_skills.push({
      skill: f.skill,
      display_name: f.display_name,
      pct_of_postings: f.pct_of_postings,
      salary_p50_vnd: f.salary_p50_vnd,
    });
  }
  recommended_skills.sort((a, b) => b.pct_of_postings - a.pct_of_postings);

  // skill_pairs: pair PHẢI tồn tại trong FACTS.co_occurrence (không phân biệt chiều);
  // mọi số LLM bịa bị vứt — RE-ATTACH từ FACTS. Comment giữ (clamp).
  const pairKey = (a: string, b: string) => [a, b].sort().join('|');
  const factPairs = new Map(facts.co_occurrence.map((p) => [pairKey(p.a, p.b), p]));
  const pairSeen = new Set<string>();
  const skill_pairs: SkillPairInsight[] = [];
  for (const item of Array.isArray(raw.skill_pairs) ? raw.skill_pairs : []) {
    const a = typeof item?.a === 'string' ? item.a : '';
    const b = typeof item?.b === 'string' ? item.b : '';
    const f = factPairs.get(pairKey(a, b));
    if (!f || pairSeen.has(pairKey(a, b))) continue;
    pairSeen.add(pairKey(a, b));
    skill_pairs.push({
      ...f,
      comment: typeof item?.comment === 'string' ? item.comment.slice(0, 280) : '',
    });
  }

  const summary =
    typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.slice(0, 600)
      : fallbackSummary(facts);

  return {
    role_code: facts.role_code,
    period: facts.period,
    personalized: facts.personalized,
    summary,
    insights: insights.slice(0, MAX_INSIGHTS),
    recommended_skills: recommended_skills.slice(0, MAX_RECOMMENDED),
    skill_pairs: skill_pairs.slice(0, MAX_PAIRS),
    cached: false,
  };
}
