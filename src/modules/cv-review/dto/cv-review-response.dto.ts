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

export interface CvReviewParsedCv {
  name: string | null;
  email: string | null;
  phone: string | null;
  skills: string[];
}

export interface CvReviewParsedResponse {
  overall_score: number;
  breakdown: {
    structure: number;
    ats: number;
    skills: number;
    experience: number;
  };
  sections: CvReviewSection[];
  parsed_cv: CvReviewParsedCv;
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
