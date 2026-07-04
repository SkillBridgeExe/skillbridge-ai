/**
 * Wave ACTION (A1) — deterministic fit strategy. A pure CLASSIFY layer on top of scores that are
 * already computed elsewhere (match `overall_score`, job-rec `recommendation_score`): given a
 * score + required-skill coverage + seniority verdict + unmet deal-breakers, `classifyFit()` returns
 * a coarse `safe_apply | stretch | not_recommended` label with a full reason trail. NO re-scoring,
 * no re-weighting — this only sorts/labels numbers other modules already produced.
 *
 * Every individual rule below is evaluated independently and appends its code when it fires —
 * INCLUDING the "positive" codes (STRONG_SCORE, STRONG_COVERAGE, SENIORITY_FITS) even when the
 * final verdict isn't safe_apply, so the FE can explain e.g. "strong score, but seniority is a
 * stretch" instead of a single flat label.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ExperienceVerdict } from '../../common/services/seniority';

export type FitReasonCode =
  | 'STRONG_SCORE'
  | 'STRONG_COVERAGE'
  | 'SENIORITY_FITS'
  | 'LOW_SCORE'
  | 'LOW_COVERAGE'
  | 'SENIORITY_STRETCH'
  | 'SENIORITY_OVERQUALIFIED'
  | 'DEAL_BREAKER_UNMET'
  | 'SEVERE_STRETCH';

export interface FitInput {
  score: number;
  required_coverage: number | null;
  seniority_verdict: ExperienceVerdict;
  /** Requirement labels the source flagged as deal-breaker AND unmet. Always [] on the job-rec path
   *  (pool jobs carry no JD dims — see job-recommendation.service.ts's buildJobRecommendation). */
  unmet_deal_breakers: string[];
  /** job-rec path only — recommendationSeniorityPolicy().level_gap (job_level rank − cv rank).
   *  Absent/undefined on the match/gap-report path (no comparable per-job level_gap there). */
  level_gap?: number;
  /** job-rec path only — recommendationSeniorityPolicy().severe_stretch. Absent on the match path. */
  severe_stretch?: boolean;
}

export interface FitVerdict {
  verdict: 'safe_apply' | 'stretch' | 'not_recommended';
  reasons: FitReasonCode[];
}

interface FitPolicy {
  version: string;
  not_recommended_score_below: number;
  safe_apply_score_at_least: number;
  safe_apply_coverage_at_least: number;
  overqualified_severe_level_gap_at_least: number;
}

const logger = new Logger('FitStrategy');
let _policyCache: FitPolicy | null = null;

/** Loads the versioned classifyFit() thresholds once (mirrors loadSkillEdges/RoleRubricService). */
function loadFitPolicy(): FitPolicy {
  if (_policyCache) return _policyCache;
  const filePath = path.join(process.cwd(), 'data', 'fit-policy-v1.json');
  _policyCache = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as FitPolicy;
  logger.log(`Loaded fit policy ${_policyCache.version}`);
  return _policyCache;
}

export function classifyFit(input: FitInput): FitVerdict {
  const policy = loadFitPolicy();
  const reasons: FitReasonCode[] = [];

  const hasCoverage = input.required_coverage != null;
  const strongScore = input.score >= policy.safe_apply_score_at_least;
  const strongCoverage =
    hasCoverage && input.required_coverage! >= policy.safe_apply_coverage_at_least;
  const lowCoverage = hasCoverage && input.required_coverage! < policy.safe_apply_coverage_at_least;
  const seniorityFits = input.seniority_verdict === 'fits';
  const lowScore = input.score < policy.not_recommended_score_below;
  const seniorityStretch = input.seniority_verdict === 'stretch';
  const severeOverQualified =
    input.seniority_verdict === 'over_qualified' &&
    input.level_gap != null &&
    Math.abs(input.level_gap) >= policy.overqualified_severe_level_gap_at_least;
  const dealBreaker = input.unmet_deal_breakers.length > 0;
  const severeStretch = input.severe_stretch === true;

  if (strongScore) reasons.push('STRONG_SCORE');
  if (strongCoverage) reasons.push('STRONG_COVERAGE');
  if (seniorityFits) reasons.push('SENIORITY_FITS');
  if (lowScore) reasons.push('LOW_SCORE');
  if (lowCoverage) reasons.push('LOW_COVERAGE');
  if (seniorityStretch) reasons.push('SENIORITY_STRETCH');
  if (severeOverQualified) reasons.push('SENIORITY_OVERQUALIFIED');
  if (dealBreaker) reasons.push('DEAL_BREAKER_UNMET');
  if (severeStretch) reasons.push('SEVERE_STRETCH');

  if (dealBreaker || lowScore || severeOverQualified || severeStretch) {
    return { verdict: 'not_recommended', reasons };
  }

  const coverageOk = !hasCoverage || strongCoverage;
  const seniorityOk = seniorityFits || input.seniority_verdict === 'unknown';
  if (strongScore && coverageOk && seniorityOk) {
    return { verdict: 'safe_apply', reasons };
  }

  return { verdict: 'stretch', reasons };
}
