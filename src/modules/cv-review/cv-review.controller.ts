import { Body, Controller, Post } from '@nestjs/common';
import { CorrelationId } from '../../common/decorators/correlation-id.decorator';
import { InternalUser } from '../../common/decorators/internal-user.decorator';
import { CvReviewRequestDto } from './dto/cv-review-request.dto';
import { CvReviewResponseDto } from './dto/cv-review-response.dto';
import { CvReviewService } from './cv-review.service';

@Controller('internal/ai')
export class CvReviewController {
  constructor(private readonly service: CvReviewService) {}

  /**
   * POST /internal/ai/cv-review
   *
   * AI quality review of a CV (no JD comparison).
   * Returns overall score + 4 breakdown scores + sections with issues + parsed CV.
   */
  @Post('cv-review')
  async review(
    @InternalUser() userId: string,
    @CorrelationId() _correlationId: string,
    @Body() body: CvReviewRequestDto,
  ): Promise<CvReviewResponseDto> {
    return this.service.review(userId, body);
  }
}
