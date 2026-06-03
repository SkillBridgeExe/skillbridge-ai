import { AtsCheckResult } from '../ats-rule-checker.service';
import { CanonicalCvDocument } from '../../../common/types/canonical-cv';
import { BulletAnalysis } from '../bullet-analyzer.service';

export interface CvReviewSectionIssue {
  severity: 'info' | 'warning' | 'error';
  text: string;
  hint?: string;
}

export interface CvReviewSection {
  name: string;
  score: number;
  issues: CvReviewSectionIssue[];
}

export interface CvReviewLlmDimensions {
  /** 0-20 each, sum = llm_total ≤ 80 */
  action_verbs: number;
  skills_relevance: number;
  experience: number;
  education: number;
}

export interface CvReviewRationale {
  action_verbs: string;
  skills_relevance: string;
  experience: string;
  education: string;
}

export interface CvReviewExtracted {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Raw skill names AS EXTRACTED by LLM (not yet normalized to taxonomy) */
  skills_raw: string[];
}

export interface CvReviewParsedResponse {
  /** Detected CV language (ISO 639-1) — feedback is produced in this language. */
  language: string;
  /** Full structured CV (Stage 1 parse output). Feeds rewrite + Harvard render. */
  document: CanonicalCvDocument;
  /** Final composite score: ats_rule_score * 0.4 + (llm_total/80*100) * 0.6 */
  overall_score: number;
  /** Deterministic 0-100 from AtsRuleCheckerService (40% weight) */
  ats_rule_score: number;
  /** Full rule check breakdown for explainability */
  ats_check: AtsCheckResult;
  /** LLM-rubric scores (4 dim × 20pt = 80) */
  llm_score_dimensions: CvReviewLlmDimensions;
  llm_total: number; // 0-80
  /** llm_total / 80 * 100 — for UI to display 0-100 scale */
  llm_normalized: number;
  rationale: CvReviewRationale;
  /** Per-dimension issues with hints (UI shows this) */
  sections: CvReviewSection[];
  /** Contact + skills derived from `document` (kept for FE backward-compat). */
  ats_extracted: CvReviewExtracted;
  /** Backward-compat alias for ats_extracted. */
  parsed_cv: CvReviewExtracted;
  /**
   * Raw deterministic signals behind the action_verbs dimension (verb-first / quantified /
   * passive ratios + 0-20 score + band + notes). Surfaced for explainability and as
   * trustworthy non-LLM labels for the calibration spine.
   */
  action_verbs_analysis: BulletAnalysis;
  /** Which versioned weight set produced `overall_score` (e.g. "scoring-weights-v1"). */
  scoring_weights_version: string;
}

export interface CvReviewResponseDto {
  ai_request_id: string;
  result_type: 'cv_review';
  raw_response: unknown;
  parsed_response: CvReviewParsedResponse;
  total_score: number;
  confidence_score: number;
  token_usage: number;
  model_code: string;
  latency_ms: number;
  prompt_template_version: number;
}
