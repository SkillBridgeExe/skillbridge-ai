export enum BillingPlanCode {
  FREE = 'FREE',
  PRO = 'PRO',
  PREMIUM = 'PREMIUM',
  INTERNAL_QA = 'INTERNAL_QA',
}

export enum BillingFeatureKey {
  CV_REVIEW = 'cv_review',
  CV_UPLOAD = 'cv_upload',
  CV_BUILDER_CREATE = 'cv_builder_create',
  CV_BUILDER_REWRITE = 'cv_builder_rewrite',
  CV_BUILDER_RENDER_PDF = 'cv_builder_render_pdf',
  CV_JD_MATCH = 'cv_jd_match',
  JOB_RECOMMENDATION = 'job_recommendation',
  INTERVIEW_SESSION = 'interview_session',
  ROADMAP_GENERATE = 'roadmap_generate',
}

export enum BillingFeaturePeriod {
  DAILY = 'DAILY',
  MONTHLY = 'MONTHLY',
}

export const BILLING_FEATURE_KEYS = Object.values(BillingFeatureKey);
export const BILLING_FEATURE_PERIODS = Object.values(BillingFeaturePeriod);
export const DEFAULT_BILLING_FEATURE_PERIOD = BillingFeaturePeriod.MONTHLY;
export const UNLIMITED_BILLING_LIMIT = -1;
