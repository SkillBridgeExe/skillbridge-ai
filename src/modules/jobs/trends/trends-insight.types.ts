/** Request to the insight endpoint. user_id is always set by the controller (JWT). */
export interface TrendsInsightRequest {
  role_code?: string;
  cv_id?: string;
  user_id: string;
  limit?: number;
}

/** Deterministic FACTS distilled from trends/gap — the ONLY source of numbers. */
export interface TrendsInsightFacts {
  role_code: string;
  period: string;
  total_active_jobs: number;
  personalized: boolean;
  skills: Array<{
    skill: string; // canonical_name
    display_name: string;
    pct_of_postings: number;
    trend_delta: number | null;
    salary_p50_vnd: number | null;
    covered: boolean | null; // null = role-level (no CV)
  }>;
}

export interface InsightItem {
  skill: string;
  display_name: string;
  pct_of_postings: number;
  trend_delta: number | null;
  covered: boolean | null;
  comment: string;
}

export interface RecommendedSkill {
  skill: string;
  display_name: string;
  pct_of_postings: number;
  salary_p50_vnd: number | null;
}

export interface TrendsInsightResponse {
  role_code: string;
  period: string;
  personalized: boolean;
  summary: string;
  insights: InsightItem[];
  recommended_skills: RecommendedSkill[];
  cached: boolean;
}

/** Shape requested from the LLM — PROSE ONLY (skill keys + text; any numbers are ignored). */
export interface TrendsInsightLlmRaw {
  summary?: unknown;
  insights?: Array<{ skill?: unknown; comment?: unknown }>;
  recommended_skills?: unknown[];
}
