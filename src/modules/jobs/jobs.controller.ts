import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../../platform/auth/decorators/current-user.decorator';
import {
  JobRecommendationResponse,
  JobRecommendationService,
} from './reco/job-recommendation.service';

/**
 * User-facing job recommendations (J4). Mirrors the cvs.controller auth posture:
 * JWT-guarded /api route; ownership of the CV is enforced in the service.
 */
@ApiTags('jobs')
@UseGuards(AuthGuard('jwt'))
@Controller('api/cvs')
export class JobsController {
  constructor(private readonly reco: JobRecommendationService) {}

  @Get(':cvId/job-recommendations')
  @ApiOperation({
    summary:
      'Job recommendations for a CV (hybrid skill-match + embedding, RRF-fused). ' +
      'Paginated: default top 5; pass ?limit=&offset= (limit≤50) to browse ALL — response carries `total`.',
  })
  recommend(
    @CurrentUser() user: JwtUser,
    @Param('cvId') cvId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('role') role?: string,
  ): Promise<JobRecommendationResponse> {
    return this.reco.recommendForCv(user.userId, cvId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      roleCode: role,
    });
  }
}
