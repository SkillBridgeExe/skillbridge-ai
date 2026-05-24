import { Module } from '@nestjs/common';
import { CvReviewController } from './cv-review.controller';
import { CvReviewService } from './cv-review.service';
import { CvReviewParser } from './cv-review.parser';

@Module({
  controllers: [CvReviewController],
  providers: [CvReviewService, CvReviewParser],
})
export class CvReviewModule {}
