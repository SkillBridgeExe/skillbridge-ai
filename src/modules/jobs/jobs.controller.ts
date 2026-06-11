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
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('role') role?: string,
  ): Promise<JobRecommendationResponse> {
    if (this.entitlements) {
      await this.entitlements.assertCanUse(user.userId, BillingFeatureKey.JOB_RECOMMENDATION);
    }
    const response = await this.reco.recommendForCv(user.userId, cvId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      roleCode: role,
    });
    if (this.entitlements) {
      await this.entitlements.recordUsage(user.userId, BillingFeatureKey.JOB_RECOMMENDATION, {
        sourceType: 'cv',
        sourceId: cvId,
      });
    }
    return response;
  }
}
