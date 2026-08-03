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
import {
  JobRecommendationQueryDto,
  toJobRecommendationOptions,
} from './dto/job-recommendation-query.dto';

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
    @Query() query: JobRecommendationQueryDto = {},
  ): Promise<JobRecommendationResponse> {
    // Validate before touching quota. Browsing an existing recommendation snapshot
    // (filter/sort/page) is free; only a cache miss generates embeddings/scores.
    const options = toJobRecommendationOptions(query);
    const quota: {
      usage: Awaited<ReturnType<EntitlementsService['reserveUsage']>> | null;
    } = { usage: null };
    try {
      const response = await this.reco.recommendForCv(user.userId, cvId, options, {
        beforeGenerate: async () => {
          quota.usage = this.entitlements
            ? await this.entitlements.reserveUsage(
                user.userId,
                BillingFeatureKey.JOB_RECOMMENDATION,
                {
                  sourceType: 'cv',
                  sourceId: cvId,
                },
              )
            : null;
        },
      });
      if (
        quota.usage &&
        (response.generation.snapshot_size === 0 || response.generation.cache_hit)
      ) {
        await quota.usage.refund();
      }
      return response;
    } catch (error) {
      await quota.usage?.refund();
      throw error;
    }
  }
}
