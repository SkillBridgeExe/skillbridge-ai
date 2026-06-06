import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ERROR_CODES } from '../../../common/constants/error-codes';
import { TracingService } from '../../../modules/tracing/tracing.service';

/** The ai_requests.request_type written by CvReviewService for every scored analysis. */
const CV_REVIEW_REQUEST_TYPE = 'cv_review';

/** ICT (UTC+7) — quota windows reset at local midnight, which is what users expect. */
const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Per-user daily cap on CV analyses. Method-scoped, so it runs AFTER the controller's
 * `AuthGuard('jwt')` and can read `req.user`. It counts the user's `cv_review` ai_requests
 * since ICT-midnight and rejects with 429 once the configured limit is reached.
 *
 * The limit comes from `CV_REVIEW_DAILY_LIMIT` (default 5; 0 disables the cap). Counting the
 * existing trace avoids a separate usage table; the current request creates the next row only
 * after this guard passes, so a user gets exactly `limit` analyses per day.
 */
@Injectable()
export class CvAnalysisQuotaGuard implements CanActivate {
  private readonly logger = new Logger(CvAnalysisQuotaGuard.name);

  constructor(
    private readonly tracing: TracingService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const limit = Number(this.config.get('CV_REVIEW_DAILY_LIMIT') ?? 5);
    if (!Number.isFinite(limit) || limit <= 0) return true; // cap disabled

    const req = ctx.switchToHttp().getRequest<{ user?: { userId?: string } }>();
    const userId = req.user?.userId;
    if (!userId) return true; // unauthenticated paths are AuthGuard's concern, not the meter's

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
    return true;
  }
}

/** The UTC instant of the most recent 00:00 in ICT (UTC+7). */
function startOfTodayIct(): Date {
  const nowIct = new Date(Date.now() + ICT_OFFSET_MS);
  nowIct.setUTCHours(0, 0, 0, 0);
  return new Date(nowIct.getTime() - ICT_OFFSET_MS);
}
