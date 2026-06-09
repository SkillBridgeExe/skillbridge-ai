import { CanonicalCvDocument } from '../types/canonical-cv';

export type SeniorityBucket = 'intern' | 'fresher' | 'junior' | 'mid' | 'senior';
const BUCKET_RANK: Record<SeniorityBucket, number> = {
  intern: 0,
  fresher: 1,
  junior: 2,
  mid: 3,
  senior: 4,
};
const JOB_LEVEL_RANK: Record<string, number> = {
  INTERN: 0,
  FRESHER: 1,
  JUNIOR: 2,
  MIDDLE: 3,
  SENIOR: 4,
  LEAD: 5,
};

export type ExperienceVerdict = 'fits' | 'stretch' | 'over_qualified' | 'unknown';
export type Confidence = 'low' | 'medium' | 'high';

export interface CvSeniority {
  bucket: SeniorityBucket;
  est_years: number | null;
  confidence: Confidence;
  signals: string[];
}
export interface ExperienceFit {
  cv_seniority: SeniorityBucket;
  job_level: string | null;
  verdict: ExperienceVerdict;
  confidence: Confidence;
}

/** Small tie-breaker magnitude ~ one RRF rank-step (k=60) so the nudge only reorders NEAR-TIES,
 *  never displacing a clear skill-winner (whose RRF gap >> 2*E). Tunable; pinned by the re-rank test. */
export const EXPERIENCE_NUDGE = 0.0005;

/** Extract a 4-digit year; "present/now/current/hiện tại/nay" → nowYear; else null. */
function parseYear(s: string | null, nowYear: number): number | null {
  if (!s) return null;
  if (/present|now|current|hiện tại|hien tai|nay/i.test(s)) return nowYear;
  const m = s.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

/** Evidence-based seniority — does NOT trust self-reported "years"; derives from structure + parsed dates. */
export function deriveCvSeniority(
  doc: CanonicalCvDocument,
  nowYear: number = new Date().getFullYear(),
): CvSeniority {
  const exp = doc.experience ?? [];
  const signals: string[] = [];

  if (exp.length === 0) {
    const hasProjects = (doc.projects ?? []).length > 0;
    signals.push(
      'no work experience',
      hasProjects ? `${doc.projects.length} projects` : 'no projects',
    );
    return {
      bucket: hasProjects ? 'fresher' : 'intern',
      est_years: null,
      confidence: 'high',
      signals,
    };
  }

  let years = 0;
  let parsed = 0;
  for (const e of exp) {
    const start = parseYear(e.start, nowYear);
    const end = parseYear(e.end, nowYear);
    if (start !== null && end !== null && end >= start) {
      years += end - start;
      parsed += 1;
    }
  }
  signals.push(`${exp.length} work entries`);

  const confidence: Confidence = parsed === exp.length ? 'high' : parsed > 0 ? 'medium' : 'low';

  let bucket: SeniorityBucket;
  if (parsed === 0) {
    bucket = exp.length >= 3 ? 'senior' : exp.length === 2 ? 'mid' : 'junior';
    signals.push('dates unparseable — count fallback');
  } else {
    signals.push(`~${years}y parsed`);
    bucket = years > 4 ? 'senior' : years >= 2 ? 'mid' : 'junior';
  }
  return { bucket, est_years: parsed > 0 ? years : null, confidence, signals };
}

export function computeExperienceFit(
  cv: CvSeniority | null,
  jobLevel: string | null,
): ExperienceFit {
  const jobRank = jobLevel ? JOB_LEVEL_RANK[jobLevel.toUpperCase()] : undefined;
  if (!cv || jobRank === undefined) {
    return {
      cv_seniority: cv?.bucket ?? 'intern',
      job_level: jobLevel,
      verdict: 'unknown',
      confidence: cv?.confidence ?? 'low',
    };
  }
  const diff = BUCKET_RANK[cv.bucket] - jobRank;
  const verdict: ExperienceVerdict = diff < -1 ? 'stretch' : diff > 1 ? 'over_qualified' : 'fits';
  return { cv_seniority: cv.bucket, job_level: jobLevel, verdict, confidence: cv.confidence };
}

const CONF_SCALE: Record<Confidence, number> = { low: 0.3, medium: 0.7, high: 1 };
/** Tie-breaker nudge added to a job's RRF score. fits favored, stretch/over penalized; scaled by confidence. */
export function experienceNudge(fit: ExperienceFit | undefined): number {
  if (!fit || fit.verdict === 'unknown') return 0;
  const base =
    fit.verdict === 'fits'
      ? EXPERIENCE_NUDGE
      : fit.verdict === 'stretch'
        ? -EXPERIENCE_NUDGE
        : -EXPERIENCE_NUDGE / 2;
  return base * CONF_SCALE[fit.confidence];
}
