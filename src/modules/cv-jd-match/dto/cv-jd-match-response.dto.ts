export interface KeywordGapEntry {
  name: string;
  status: 'FOUND' | 'PARTIAL' | 'MISSING';
  progress: number;
}

export interface CriteriaScore {
  criteria_name: string;
  score: number;
  weight: number;
}

export interface CvJdMatchParsedResponse {
  overall_score: number;
  semantic_score: number;
  ats_score: number;
  llm_score: number;
  rule_engine_score: number;
  radar: Record<string, number>;
  keyword_gap: {
    hard_skills: KeywordGapEntry[];
    soft_skills: KeywordGapEntry[];
  };
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  criteria_scores: CriteriaScore[];
}

export interface CvJdMatchResponseDto {
  ai_request_id: string;
  result_type: 'cv_jd_match';
  parsed_response: CvJdMatchParsedResponse;
  retrieval_log_id: string | null;
  retrieved_chunks_count: number;
  token_usage: number;
  latency_ms: number;
}
