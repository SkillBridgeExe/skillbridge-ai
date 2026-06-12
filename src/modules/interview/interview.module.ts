import { Module } from '@nestjs/common';
import { InterviewController } from './interview.controller';
import { InterviewService } from './interview.service';
import { InterviewPlanService } from './interview-plan.service';
import { CvJdMatchModule } from '../cv-jd-match/cv-jd-match.module';

@Module({
  imports: [CvJdMatchModule],
  controllers: [InterviewController],
  providers: [InterviewService, InterviewPlanService],
  exports: [InterviewService, InterviewPlanService],
})
export class InterviewModule {}
