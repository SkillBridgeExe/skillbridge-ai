import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../../../platform/auth/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { SkillDemandService, SkillGapResponse, SkillTrendsResponse } from './skill-demand.service';
import { TrendsInsightService } from './trends-insight.service';
import { TrendsInsightResponse } from './trends-insight.types';

/** J5 — skill-demand trends + per-CV gap + AI insight. JWT, same posture as /api/cvs.
 * @Public() bypasses the global X-Internal-Auth guard; @UseGuards(jwt) still enforces the user. */
@ApiTags('trends')
@Public()
@UseGuards(AuthGuard('jwt'))
@Controller('api/trends')
export class TrendsController {
  constructor(
    private readonly demand: SkillDemandService,
    private readonly insight: TrendsInsightService,
  ) {}

  @Get('skills')
  @ApiOperation({ summary: 'Top in-demand skills (latest snapshot; role=all|<role_code>)' })
  trends(
    @Query('role') role?: string,
    @Query('limit') limit?: string,
  ): Promise<SkillTrendsResponse> {
    return this.demand.getTrends(role ?? 'all', limit ? parseInt(limit, 10) : undefined);
  }

  @Get('skills/gap/:cvId')
  @ApiOperation({ summary: 'Role demand vs THIS CV — missing skills = upskilling suggestions' })
  gap(
    @CurrentUser() user: JwtUser,
    @Param('cvId') cvId: string,
    @Query('role') role?: string,
    @Query('limit') limit?: string,
  ): Promise<SkillGapResponse> {
    return this.demand.getSkillGap(
      user.userId,
      cvId,
      role ?? 'all',
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get('insight')
  @ApiOperation({ summary: 'AI "nhận định" over trends (grounded; cv_id optional → personalized)' })
  insightHandler(
    @CurrentUser() user: JwtUser,
    @Query('role') role?: string,
    @Query('cv_id') cvId?: string,
    @Query('limit') limit?: string,
  ): Promise<TrendsInsightResponse> {
    return this.insight.generate({
      role_code: role ?? 'all',
      cv_id: cvId,
      user_id: user.userId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
