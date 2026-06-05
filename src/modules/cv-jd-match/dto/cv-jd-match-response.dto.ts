import {
  BonusSkill,
  DiffResult,
  MatchedSkill,
  MissingSkill,
  PartialSkill,
  UnnormalizedSkill,
} from '../skill-diff.service';

/**
 * Response from the refactored CV-JD match flow.
 *
 * Key differences vs previous version:
 *   - `matched_skills` / `missing_skills` / `partial_skills` are now explicit arrays
 *     (was previously a single keyword_gap with FOUND|PARTIAL|MISSING status).
 *   - `overall_score` is computed by SkillDiffService (weighted from rubric), not LLM.
 *   - LLM only extracts; no LLM-generated scores in this response.
 *   - `unnormalized_*` arrays surface skills that didn't match taxonomy — useful signal
 *     for product team to expand the taxonomy.
 */
export interface CvJdMatchParsedResponse {
  /** Weighted composite 0-100 from SkillDiffService.computeMatchScore() */
  overall_score: number;
  /** Simple ratio matched/total × 100 — easier to communicate to users */
  match_ratio: number;

  matched_skills: MatchedSkill[];
  partial_skills: PartialSkill[];
  missing_skills: MissingSkill[];
  /** CV skills the role doesn't require — strengths to display, never subtracted. */
  bonus_skills: BonusSkill[];

  /** Fraction of REQUIRED skills met (0-1). Explains the coverage cap on overall_score. */
  required_coverage: number;

  /** CV skills LLM extracted but couldn't normalize → flag for taxonomy expansion */
  unnormalized_cv_skills: UnnormalizedSkill[];
  /** JD requirements LLM extracted but couldn't normalize → flag for taxonomy expansion */
  unnormalized_jd_requirements: UnnormalizedSkill[];

  /** Breakdown for transparency / audit — referenced from DiffResult so it can't drift. */
  scoring_breakdown: DiffResult['scoring_breakdown'];

  /** Indicates which source was used for "required skills". */
  source_of_requirements: 'role_rubric' | 'jd_extraction' | 'none';
  /** Echo of target_role if rubric was used. */
  target_role: string | null;
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
