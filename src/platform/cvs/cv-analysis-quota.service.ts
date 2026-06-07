import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { TracingService } from '../../modules/tracing/tracing.service';

/** The ai_requests.request_type written by CvReviewService for every scored analysis. */
const CV_REVIEW_REQUEST_TYPE = 'cv_review';

/** ICT (UTC+7) — quota windows reset at local midnight, which is what users expect. */
const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Per-user daily cap on CV analyses (cv_review). Enforced from inside CvsService at the two
 * scoring entry points — `create()` (after the generated-PDF bypass and before any storage/row
 * write) and `rerunReview()` — so that:
 *   - a builder-generated-PDF re-upload (which CvsService short-circuits without scoring) never
 *     consumes or is blocked by this quota, and
 *   - a quota rejection happens BEFORE the file is stored / the CV row is created (no orphan row).
 *
 * Deliberately NOT a route guard: a guard runs in the controller before CvsService can detect
 * the generated-PDF bypass, so it would wrongly block a re-upload that was never going to score.
 *
 * The limit comes from `CV_REVIEW_DAILY_LIMIT` (default 5; 0 disables). It is a shared budget:
 * new-upload scoring and re-run both draw from it (a re-run costs the same model spend as a new
 * analysis). Counting the existing ai_requests trace avoids a separate usage table.
 */
@Injectable()
export class CvAnalysisQuotaService {
  private readonly logger = new Logger(CvAnalysisQuotaService.name);

  constructor(
    private readonly tracing: TracingService,
    private readonly config: ConfigService,
  ) {}

  async assertWithinDailyLimit(userId: string): Promise<void> {
    const limit = Number(this.config.get('CV_REVIEW_DAILY_LIMIT') ?? 5);
    if (!Number.isFinite(limit) || limit <= 0) return; // cap disabled
    if (!userId) return;

    const used = await this.tracing.countRequestsSince(
      userId,
      CV_REVIEW_REQUEST_TYPE,
      startOfTodayIct(),
    );

    if (used >= limit) {
      this.logger.warn(`CV analysis quota reached: user=${userId} used=${used} limit=${limit}`);
      throw new HttpException(
        {
          errorCode: ERROR_CODES.CV_ANALYSIS_DAILY_LIMIT_REACHED,
          message: `Bạn đã dùng hết ${limit} lượt phân tích CV trong hôm nay. Lượt mới sẽ được làm mới vào 00:00 (giờ Việt Nam).`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** The UTC instant of the most recent 00:00 in ICT (UTC+7). */
function startOfTodayIct(): Date {
  const nowIct = new Date(Date.now() + ICT_OFFSET_MS);
  nowIct.setUTCHours(0, 0, 0, 0);
  return new Date(nowIct.getTime() - ICT_OFFSET_MS);
}
