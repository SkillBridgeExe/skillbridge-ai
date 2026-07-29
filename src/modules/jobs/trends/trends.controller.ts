import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Optional,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../../../platform/auth/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { SkillDemandService, SkillGapResponse, SkillTrendsResponse } from './skill-demand.service';
import { TrendsInsightService } from './trends-insight.service';
import { TrendsInsightResponse } from './trends-insight.types';
import { EntitlementsService } from '../../../platform/billing/entitlements.service';
import { BillingPlanCode } from '../../../common/constants/billing.constants';
import { ERROR_CODES } from '../../../common/constants/error-codes';

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
    @Optional() private readonly entitlements?: EntitlementsService,
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
  async gap(
    @CurrentUser() user: JwtUser,
    @Param('cvId') cvId: string,
    @Query('role') role?: string,
    @Query('limit') limit?: string,
  ): Promise<SkillGapResponse> {
    const hasPremiumAccess = await this.entitlements?.hasActivePlan(
      user.userId,
      BillingPlanCode.PREMIUM,
    );
    if (!hasPremiumAccess) {
      throw new HttpException(
        {
          errorCode: ERROR_CODES.FEATURE_NOT_INCLUDED,
          message: 'Premium is required to view personalized market skill gaps.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
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
