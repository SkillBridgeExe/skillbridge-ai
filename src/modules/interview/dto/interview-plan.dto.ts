import { CvReviewParsedResponse } from '../../cv-review/dto/cv-review-response.dto';
import { InterviewFocusArea } from '../interview-planner';

export interface InterviewPlanRequestDto {
  /** The CV's latest cv_review parsed_response — loaded by the platform caller (Tuấn's lane). */
  review: CvReviewParsedResponse;
  /** Role rubric code (NOT stored on the review) — e.g. 'frontend_developer'. */
  target_role: string;
  /** Question language. Default 'vi'. */
  lang?: 'vi' | 'en';
}

export interface InterviewPlanItem extends InterviewFocusArea {
  /** LLM-phrased question, or the deterministic template fallback. */
  question: string;
  /** "What a good answer covers" — empty when template-only. */
  good_answer_hints: string[];
}

export interface InterviewPlanResponseDto {
  ai_request_id: string;
  target_role: string;
  language: 'vi' | 'en';
  items: InterviewPlanItem[];
  /** false = LLM unavailable; questions are the deterministic templates. */
  llm_enhanced: boolean;
  token_usage: number;
  /** True when there were no skill-type gaps to probe (honest empty-state, no LLM call). */
  no_focus_areas?: boolean;
}
