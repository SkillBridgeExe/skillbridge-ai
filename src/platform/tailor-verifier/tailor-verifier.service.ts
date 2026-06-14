import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { CvJdMatchParsedResponse } from '../../modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { CvReviewParsedResponse } from '../../modules/cv-review/dto/cv-review-response.dto';
import { GapReportService } from '../../modules/gap-report/gap-report.service';
import {
  VerifiedTailorAction,
  verifyTailorAction,
} from '../../modules/cv-builder/tailor-verification';

/**
 * PR4.5 — the platform-side LOADER for the server-verified tailor rewrite. Standalone provider
 * (repos + GapReportService only) so it can be injected into CvsService WITHOUT re-introducing the
 * CvsModule ↔ CvMatchesModule cycle (it depends on neither service).
 *
 * It reproduces the exact ownership + gap-report load path CvMatchesService.getGapReport uses, then
 * delegates the deterministic decision to the pure AI-lane verifyTailorAction(). It NEVER calls the
 * LLM and records no usage — that stays in CvsService.rewriteBuilderText around this call.
 *
 * Ownership is defence-in-depth: the CV in the route (`cvId`) AND the match's CV must be the same,
 * and that CV must belong to the caller — so a forged match_id pointing at another user's match
 * (or another CV of the caller's) is rejected before any rewrite.
 */
@Injectable()
export class TailorVerifierService {
  constructor(
    @InjectRepository(CvMatchEntity) private readonly matches: Repository<CvMatchEntity>,
    @InjectRepository(AiResultEntity) private readonly aiResults: Repository<AiResultEntity>,
    @InjectRepository(CvEntity) private readonly cvs: Repository<CvEntity>,
    private readonly gapReport: GapReportService,
  ) {}

  async verify(input: {
    userId: string;
    cvId: string;
    matchId: string;
    actionId: string;
    text: string;
    lang?: 'vi' | 'en';
  }): Promise<VerifiedTailorAction> {
    const lang = input.lang ?? 'vi';

    const match = await this.matches.findOne({ where: { id: input.matchId } });
    if (!match) throw new NotFoundException('CV match not found');
    // Confused-deputy guard: the match must belong to the CV named in the route.
    if (match.cvId !== input.cvId) throw new NotFoundException('CV match not found');
    // Ownership: that CV must belong to the caller.
    const cv = await this.cvs.findOne({
      where: { id: match.cvId, userId: input.userId, deletedAt: IsNull() },
    });
    if (!cv) throw new NotFoundException('CV not found');

    // Reject legacy rows without a stored AI result: their reconstructed match is lossy
    // (target_role=null), which would yield a DIFFERENT gap report than the FE rendered — unsafe to
    // verify an action against. Re-running the match repopulates ai_results.parsed_response.
    if (!match.aiResultId) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        code: 'MATCH_TOO_OLD',
        message:
          'Phân tích này quá cũ để viết lại theo JD — hãy chạy lại so khớp CV↔JD. / ' +
          'This match predates the gap engine — re-run the CV↔JD match before tailoring.',
      });
    }
    const aiRow = await this.aiResults.findOne({ where: { id: match.aiResultId } });
    const parsed = aiRow?.parsedResponse;
    if (!parsed || typeof parsed !== 'object') throw new NotFoundException('CV match not found');

    const review = await this.getLatestReview(input.userId, match.cvId);
    if (!review) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        code: 'NO_REVIEW',
        message:
          'Hãy chạy chẩn đoán CV trước khi viết lại theo JD. / ' +
          'Run CV diagnosis before tailoring to a JD.',
      });
    }

    // Rebuild the SAME deterministic gap report the FE rendered, then verify the action against it.
    const report = await this.gapReport.build({
      match: parsed as CvJdMatchParsedResponse,
      review,
      lang,
    });
    return verifyTailorAction(
      report.recommended_actions,
      { actionId: input.actionId, text: input.text },
      review.document ?? null,
    );
  }

  /**
   * Latest cv_review parsed_response for (user, cv). EXACT mirror of CvsService.getLatestReview —
   * duplicated (not imported) on purpose so this provider depends on NEITHER CvsService nor
   * CvMatchesService, keeping the module graph acyclic. It MUST match that query (no role/prompt
   * predicate) so the rebuilt gap report is byte-identical to the one getGapReport produced — the
   * report the FE rendered the action_id from. Keep the two in sync if either changes.
   */
  private async getLatestReview(
    userId: string,
    cvId: string,
  ): Promise<CvReviewParsedResponse | null> {
    const rows = (await this.aiResults.manager.query(
      `
        SELECT ar.parsed_response
        FROM ai_results ar
        INNER JOIN ai_requests req ON req.id = ar.ai_request_id
        WHERE ar.user_id = $1
          AND ar.result_type = $2
          AND req.request_payload -> 'payload' ->> 'cv_id' = $3
        ORDER BY ar.created_at DESC
        LIMIT 1
      `,
      [userId, BillingFeatureKey.CV_REVIEW, cvId],
    )) as Array<{ parsed_response: CvReviewParsedResponse | null }>;

    return rows[0]?.parsed_response ?? null;
  }
}
