import { Body, Controller, Post } from '@nestjs/common';
import { CorrelationId } from '../../common/decorators/correlation-id.decorator';
import { InternalUser } from '../../common/decorators/internal-user.decorator';
import { CvJdMatchRequestDto } from './dto/cv-jd-match-request.dto';
import { CvJdMatchResponseDto } from './dto/cv-jd-match-response.dto';
import { CvJdMatchService } from './cv-jd-match.service';

@Controller('internal/ai')
export class CvJdMatchController {
  constructor(private readonly service: CvJdMatchService) {}

  /**
   * POST /internal/ai/cv-jd-match
   *
   * CV vs JD composite scoring + skill gap analysis.
   * Uses RAG retrieval over CV and JD chunks before the LLM call.
   */
  @Post('cv-jd-match')
  async match(
    @InternalUser() userId: string,
    @CorrelationId() _correlationId: string,
    @Body() body: CvJdMatchRequestDto,
  ): Promise<CvJdMatchResponseDto> {
    return this.service.match(userId, body);
  }
}
