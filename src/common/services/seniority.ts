import { CanonicalCvDocument } from '../types/canonical-cv';

export type SeniorityBucket = 'intern' | 'fresher' | 'junior' | 'mid' | 'senior';
/** CV seniority bucket → ordinal rank (0-4). Exported additively for the Gap Engine's seniority
 *  GapItem (PR3). There is NO 'lead' CV bucket, so the CV signal tops out at senior (rank 4): under
 *  the ±1 fits-tolerance a LEAD-required JD (rank 5) is still 'matched' for a senior CV, but a real
 *  gap for any CV two-or-more levels below. */
export const BUCKET_RANK: Record<SeniorityBucket, number> = {
  intern: 0,
  fresher: 1,
  junior: 2,
  mid: 3,
  senior: 4,
};
/** JD level hint → ordinal rank (0-5). Exported additively for the Gap Engine's seniority GapItem (PR3). */
export const JOB_LEVEL_RANK: Record<string, number> = {
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

function isInternshipEntry(e: CanonicalCvDocument['experience'][number]): boolean {
  const text = `${e.role ?? ''} ${e.org ?? ''} ${(e.bullets ?? []).join(' ')}`;
  return /\bintern(ship)?\b|thực tập|thuc tap|internship trainee|trainee/i.test(text);
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
  let internshipEntries = 0;
  for (const e of exp) {
    if (isInternshipEntry(e)) internshipEntries += 1;
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
    if (years === 0 && internshipEntries === exp.length) {
      const hasProjects = (doc.projects ?? []).length > 0;
      bucket = hasProjects ? 'fresher' : 'intern';
      signals.push('short internship');
    } else {
      bucket = years > 4 ? 'senior' : years >= 2 ? 'mid' : 'junior';
    }
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

/**
 * Job-recommendation seniority POLICY (separate from the tiny RRF nudge above). The nudge only breaks
 * near-ties; this returns a real DEMOTION factor so a fresher's CV does not surface SENIOR/LEAD jobs as
 * normal top recommendations even when the skill overlap is high.
 *
 *   factor — multiplier in (0,1] applied to the ranking score AND to surface `recommendation_score`
 *            (= skill match_score × factor). 1.0 = no demotion.
 *   severe_stretch — gap ≥ 3 levels (e.g. fresher → LEAD); the FE can badge / filter these.
 *   level_gap — job_level rank − cv rank (positive = the job sits ABOVE the candidate).
 *
 * Only `stretch` (CV ≥ 2 levels below the job) is demoted. `fits`, `over_qualified`, and crucially
 * `unknown` (no reliable signal) are NEVER penalized. Low CV-seniority confidence softens the demotion
 * so an uncertain estimate cannot hard-bury an otherwise strong skill match. Pure + deterministic.
 */
export interface RecommendationSeniorityPolicy {
  factor: number;
  severe_stretch: boolean;
  level_gap: number;
}

export function recommendationSeniorityPolicy(
  fit: ExperienceFit | undefined,
): RecommendationSeniorityPolicy {
  const NEUTRAL: RecommendationSeniorityPolicy = { factor: 1, severe_stretch: false, level_gap: 0 };
  if (!fit || fit.verdict === 'unknown' || !fit.job_level) return NEUTRAL;
  const jobRank = JOB_LEVEL_RANK[fit.job_level.toUpperCase()];
  if (jobRank === undefined) return NEUTRAL;
  const level_gap = jobRank - BUCKET_RANK[fit.cv_seniority];
  if (fit.verdict !== 'stretch') return { factor: 1, severe_stretch: false, level_gap };

  const severe = level_gap >= 3;
  const low = fit.confidence === 'low';
  const factor = severe ? (low ? 0.7 : 0.4) : low ? 0.85 : 0.65;
  return { factor, severe_stretch: severe, level_gap };
}
