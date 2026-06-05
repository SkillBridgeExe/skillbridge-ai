import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../../../platform/auth/decorators/current-user.decorator';
import { SkillDemandService, SkillGapResponse, SkillTrendsResponse } from './skill-demand.service';

/** J5 — skill-demand trends + per-CV gap (upskilling suggestions). JWT, same posture as /api/cvs. */
@ApiTags('trends')
@UseGuards(AuthGuard('jwt'))
@Controller('api/trends')
export class TrendsController {
  constructor(private readonly demand: SkillDemandService) {}

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
}
