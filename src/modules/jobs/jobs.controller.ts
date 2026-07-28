import { Controller, Get, Optional, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { CurrentUser, JwtUser } from '../../platform/auth/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { EntitlementsService } from '../../platform/billing/entitlements.service';
import {
  JobRecommendationResponse,
  JobRecommendationService,
} from './reco/job-recommendation.service';
import { JobRecommendationQueryDto } from './dto/job-recommendation-query.dto';

/**
 * User-facing job recommendations (J4). Mirrors the cvs.controller auth posture:
 * @Public() bypasses the global X-Internal-Auth guard; @UseGuards(jwt) still enforces the
 * user session, and ownership of the CV is enforced in the service.
 */
@ApiTags('jobs')
@Public()
@UseGuards(AuthGuard('jwt'))
@Controller('api/cvs')
export class JobsController {
  constructor(
    private readonly reco: JobRecommendationService,
    // @Optional ONLY for the DB-less env (NODE_ENV=test skips BillingModule — see
    // jobs.module.ts). Every real runtime provides it and quota IS enforced.
    @Optional() private readonly entitlements?: EntitlementsService,
  ) {}

  @Get(':cvId/job-recommendations')
  @ApiOperation({
    summary:
      'Job recommendations for a CV (hybrid skill-match + embedding, RRF-fused). ' +
      'Paginated: default top 5; pass ?limit=&offset= (limit≤50) to browse ALL — response carries `total`.',
  })
  async recommend(
    @CurrentUser() user: JwtUser,
    @Param('cvId') cvId: string,
    @Query() query: JobRecommendationQueryDto = new JobRecommendationQueryDto(),
  ): Promise<JobRecommendationResponse> {
    // One CV consumes one recommendation credit per entitlement period. Pagination/filter/sort
    // requests for that same CV reuse the source charge instead of burning quota per page.
    const usage = this.entitlements
      ? await this.entitlements.reserveUsage(
          user.userId,
          BillingFeatureKey.JOB_RECOMMENDATION,
          {
            sourceType: 'cv',
            sourceId: cvId,
          },
          {
            dedupeBySource: true,
          },
        )
      : null;
    try {
      const response = await this.reco.recommendForCv(user.userId, cvId, {
        limit: query.limit,
        offset: query.offset,
        roleCode: query.role === 'all' ? null : query.role,
        cityCodes: query.cityCodes,
        workModes: query.workModes,
        employmentTypes: query.employmentTypes,
        experienceLevels: query.experienceLevels,
        fitVerdicts: query.fit,
        sort: query.sort,
        salaryOnly: query.salaryOnly,
      });
      // Refund ONLY a genuinely empty pool (total === 0). An over-paginated
      // page (offset >= total) also yields an empty `recommendations` array but
      // total > 0 — the full scoring+embedding pipeline already ran, so
      // refunding it would let a client farm unlimited free scored calls by
      // requesting past-the-end offsets (bug hunt R2 07-22).
      if (usage && !usage.reused && response.total === 0) {
        await usage.refund();
      }
      return response;
    } catch (error) {
      await usage?.refund();
      throw error;
    }
  }
}
