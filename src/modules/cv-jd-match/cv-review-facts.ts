/**
 * RECOMMENDATION' (R1) — shared CV-skill FACT BUILDER for every job-scoring surface.
 *
 * Both the job-recommendation cards (JobRecommendationService) and the candidate apply/match path
 * (CandidateJobService.computeMatch) must score a CV from the SAME fact set: the latest CV review's
 * proficiency-bearing skills when a review exists, presence-only cv_skills canonicals otherwise.
 * Before R1 the apply path was presence-only while the card was proficiency-aware — the same CV/job
 * pair produced two different skill scores with no label (audit P0-4).
 *
 * The SQL is the ownership-checked variant of CvsService.getLatestReview (adds the cvs join for
 * user_id + deleted_at) that JobRecommendationService used to carry privately — no DI on CvsService
 * on purpose (raw-query service; importing CvsModule would couple/cycle). TailorVerifierService keeps
 * its OWN join-less mirror deliberately: its report must be byte-identical to getGapReport's, which
 * uses CvsService.getLatestReview verbatim. Keep this in sync with that query if it ever changes.
 */
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { RawCvSkill } from './skill-diff.service';

export type ReviewSkills = CvReviewParsedResponse['ats_extracted']['skills_extracted'];

/** Minimal query surface satisfied by BOTH DatabaseService (raw pg) and a TypeORM DataSource. */
export interface SqlQueryable {
  query(
    sql: string,
    params: unknown[],
  ): Promise<Array<{ parsed_response: CvReviewParsedResponse | null }>>;
}

const LATEST_REVIEW_SKILLS_SQL = `
        SELECT ar.parsed_response
        FROM ai_results ar
        INNER JOIN ai_requests req ON req.id = ar.ai_request_id
        INNER JOIN cvs c
          ON c.id = (req.request_payload -> 'payload' ->> 'cv_id')::uuid
         AND c.user_id = ar.user_id
         AND c.deleted_at IS NULL
        WHERE ar.user_id = $1
          AND ar.result_type = $2
          AND req.request_payload -> 'payload' ->> 'cv_id' = $3
        ORDER BY ar.created_at DESC
        LIMIT 1
      `;

/**
 * Latest cv_review's proficiency-bearing skills for (user, cv) — `ats_extracted.skills_extracted`
 * (CvSkillExtracted[]: {name, proficiency_hint, evidence_text}), the SAME shape cv-jd-match's LLM
 * extraction produces (RawCvSkill). null when no review exists (fresh CV, review failed) — callers
 * fall back to presence-only canonicals via toRawCvSkills().
 */
export async function loadLatestReviewSkills(
  db: SqlQueryable,
  userId: string,
  cvId: string,
): Promise<ReviewSkills | null> {
  const rows = await db.query(LATEST_REVIEW_SKILLS_SQL, [
    userId,
    BillingFeatureKey.CV_REVIEW,
    cvId,
  ]);
  return rows[0]?.parsed_response?.ats_extracted?.skills_extracted ?? null;
}

/** Review skills (name + proficiency_hint) when available; presence-only canonicals otherwise. */
export function toRawCvSkills(
  review: ReviewSkills | null,
  fallbackCanonicals: string[],
): RawCvSkill[] {
  return review && review.length > 0
    ? review.map((s) => ({ name: s.name, proficiency_hint: s.proficiency_hint }))
    : fallbackCanonicals.map((name) => ({ name }));
}
