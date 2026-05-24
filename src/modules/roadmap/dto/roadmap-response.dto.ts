export interface RoadmapStep {
  title: string;
  description: string;
  step_order: number;
  estimated_days: number;
  skills_addressed: string[];
  suggested_resource_keywords: string[];
}

export interface RoadmapParsedResponse {
  title: string;
  total_weeks: number;
  ai_summary: string;
  ai_advice: string;
  steps: RoadmapStep[];
}

export interface RoadmapGenerateResponseDto {
  ai_request_id: string;
  parsed_response: RoadmapParsedResponse;
  retrieval_log_id: string | null;
  retrieved_chunks_count: number;
  token_usage: number;
}
