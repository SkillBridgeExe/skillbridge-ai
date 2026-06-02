import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
  review(@CurrentUser() user: JwtUser, @Body() dto: PlatformCvReviewRequestDto) {
    return this.cvs.rerunReview(user.userId, dto.cvId);
  }

  @Get('history')
  history(@CurrentUser() user: JwtUser, @Query() query: CvListQueryDto) {
    return this.cvs.list(user.userId, query);
  }
}
