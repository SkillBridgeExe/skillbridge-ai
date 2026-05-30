import { ScoredCourse } from '../course-matcher.service';

export interface RoadmapPhase {
  phase_name: string;
  order: number;
  weeks: number;
  rationale: string;
}

export interface RoadmapStep {
  title: string;
  description: string;
  step_order: number;
  phase_order: number;
  estimated_days: number;
  /** Canonical skill IDs this step teaches (normalized) */
  skill_canonical_names: string[];
  learning_objectives: string[];
  /** Real courses from catalog, populated by CourseMatcherService — NOT LLM keywords */
  recommended_courses: ScoredCourse[];
}

export interface RoadmapParsedResponse {
  title: string;
  total_weeks: number;
  phases: RoadmapPhase[];
  steps: RoadmapStep[];
  ai_summary: string;
  ai_advice: string;
  /** Skills LLM referenced but were not in our taxonomy/gap list — sanity check signal */
  uncovered_skills: string[];
  /** Skills with zero catalog hits — flag for course curation team */
  skills_without_courses: string[];
}

export interface RoadmapGenerateResponseDto {
  ai_request_id: string;
  parsed_response: RoadmapParsedResponse;
  retrieval_log_id: string | null;
  retrieved_chunks_count: number;
  token_usage: number;
}
