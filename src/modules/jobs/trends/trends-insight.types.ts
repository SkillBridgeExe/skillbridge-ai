/** Request to the insight endpoint. user_id is always set by the controller (JWT). */
export interface TrendsInsightRequest {
  role_code?: string;
  cv_id?: string;
  user_id: string;
  limit?: number;
}

/** Deterministic FACTS distilled from trends/gap — the ONLY source of numbers. */
/** Cặp kỹ năng xuất hiện CÙNG một tin tuyển dụng (đếm SQL trên pool active — compute-on-read). */
export interface CoOccurrencePair {
  a: string;
  a_display: string;
  b: string;
  b_display: string;
  pair_count: number;
  /** pair_count / tổng tin active của role, % (1 chữ số thập phân). */
  pct_of_postings: number;
}

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
  /** Insight sâu v1: cặp kỹ năng đi cùng nhau — nguồn DUY NHẤT cho skill_pairs. */
  co_occurrence: CoOccurrencePair[];
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

/** Nhận định cụm kỹ năng — pair PHẢI tồn tại trong FACTS, số RE-ATTACH từ FACTS. */
export interface SkillPairInsight extends CoOccurrencePair {
  comment: string;
}

export interface TrendsInsightResponse {
  role_code: string;
  period: string;
  personalized: boolean;
  summary: string;
  insights: InsightItem[];
  recommended_skills: RecommendedSkill[];
  /** Insight sâu v1 (có thể rỗng khi pool/LLM không có cặp đáng nói). */
  skill_pairs: SkillPairInsight[];
  cached: boolean;
}

/** Shape requested from the LLM — PROSE ONLY (skill keys + text; any numbers are ignored). */
export interface TrendsInsightLlmRaw {
  summary?: unknown;
  insights?: Array<{ skill?: unknown; comment?: unknown }>;
  recommended_skills?: unknown[];
  skill_pairs?: Array<{ a?: unknown; b?: unknown; comment?: unknown }>;
}
