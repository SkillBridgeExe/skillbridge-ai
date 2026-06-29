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

export interface BillingFeatureCatalogItem {
  featureKey: BillingFeatureKey;
  label: string;
  description: string;
  allowedPeriods: BillingFeaturePeriod[];
  recommendedLimits: Record<
    BillingPlanCode.FREE | BillingPlanCode.PRO | BillingPlanCode.PREMIUM,
    number
  >;
}

export const BILLING_FEATURE_CATALOG: BillingFeatureCatalogItem[] = [
  {
    featureKey: BillingFeatureKey.CV_REVIEW,
    label: 'CV diagnosis',
    description: 'AI CV analysis, ATS checks, scoring and feedback.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 3,
      [BillingPlanCode.PRO]: 30,
      [BillingPlanCode.PREMIUM]: 100,
    },
  },
  {
    featureKey: BillingFeatureKey.CV_UPLOAD,
    label: 'CV uploads',
    description: 'Stored CV uploads and parsed CV documents.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 10,
      [BillingPlanCode.PRO]: 50,
      [BillingPlanCode.PREMIUM]: 150,
    },
  },
  {
    featureKey: BillingFeatureKey.CV_BUILDER_CREATE,
    label: 'CV builder drafts',
    description: 'Create structured CV builder drafts.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 3,
      [BillingPlanCode.PRO]: 20,
      [BillingPlanCode.PREMIUM]: 60,
    },
  },
  {
    featureKey: BillingFeatureKey.CV_BUILDER_REWRITE,
    label: 'CV rewrite credits',
    description: 'AI rewrite, intake extraction, and tailor rewrite actions.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 5,
      [BillingPlanCode.PRO]: 100,
      [BillingPlanCode.PREMIUM]: 300,
    },
  },
  {
    featureKey: BillingFeatureKey.CV_BUILDER_RENDER_PDF,
    label: 'CV PDF exports',
    description: 'Render built CV drafts to PDF.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 3,
      [BillingPlanCode.PRO]: 50,
      [BillingPlanCode.PREMIUM]: 150,
    },
  },
  {
    featureKey: BillingFeatureKey.CV_JD_MATCH,
    label: 'CV/JD matches',
    description: 'Match a CV against a job description and generate gap signals.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 3,
      [BillingPlanCode.PRO]: 30,
      [BillingPlanCode.PREMIUM]: 100,
    },
  },
  {
    featureKey: BillingFeatureKey.JOB_RECOMMENDATION,
    label: 'Job recommendations',
    description: 'Recommended jobs for a CV.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 10,
      [BillingPlanCode.PRO]: 100,
      [BillingPlanCode.PREMIUM]: 300,
    },
  },
  {
    featureKey: BillingFeatureKey.INTERVIEW_SESSION,
    label: 'Interview sessions',
    description: 'AI interview practice sessions and interview plans.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 0,
      [BillingPlanCode.PRO]: 5,
      [BillingPlanCode.PREMIUM]: 25,
    },
  },
  {
    featureKey: BillingFeatureKey.ROADMAP_GENERATE,
    label: 'Learning roadmaps',
    description: 'Generate a learning roadmap from a match gap report.',
    allowedPeriods: [BillingFeaturePeriod.MONTHLY],
    recommendedLimits: {
      [BillingPlanCode.FREE]: 1,
      [BillingPlanCode.PRO]: 10,
      [BillingPlanCode.PREMIUM]: 30,
    },
  },
];
