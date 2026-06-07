import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { CvListQueryDto } from './dto/cv-list-query.dto';
import { PlatformCvReviewRequestDto } from './dto/cv-review-request.dto';
import { CvsService } from './cvs.service';

@ApiTags('Diagnosis')
@ApiBearerAuth()
@Public()
@UseGuards(AuthGuard('jwt'))
@Controller('api/diagnosis')
export class DiagnosisController {
  constructor(private readonly cvs: CvsService) {}

  @Post('cv-review')
  @ApiOperation({
    summary: 'Re-run AI diagnosis for an existing CV',
    description:
      'Uses the previously extracted CV text and persisted targetRole, calls CV diagnosis again, updates parsed CV/ATS score/skills, stores a new ai_results trace, and returns the fresh review.',
  })
  @ApiBody({ type: PlatformCvReviewRequestDto })
  review(@CurrentUser() user: JwtUser, @Body() dto: PlatformCvReviewRequestDto) {
    return this.cvs.rerunReview(user.userId, dto.cvId);
  }

  @Get('history')
  @ApiOperation({
    summary: 'List CV diagnosis history',
    description: 'Alias of CV list for the current user, intended for diagnosis/history screens.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    example: 1,
    description: 'Page number, starting at 1.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 20, description: 'Items per page, max 50.' })
  history(@CurrentUser() user: JwtUser, @Query() query: CvListQueryDto) {
    return this.cvs.list(user.userId, query);
  }
}
