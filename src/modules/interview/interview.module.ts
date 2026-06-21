import { Module } from '@nestjs/common';
import { InterviewController } from './interview.controller';
import { InterviewService } from './interview.service';
import { InterviewPlanService } from './interview-plan.service';
import { CvJdMatchModule } from '../cv-jd-match/cv-jd-match.module';
import { AnswerInsightService } from './answer-insight.service';
import { InterviewCoachingService } from './interview-coaching.service';

@Module({
  imports: [CvJdMatchModule],
  controllers: [InterviewController],
  providers: [
    InterviewService,
    InterviewPlanService,
    AnswerInsightService,
    InterviewCoachingService,
  ],
  exports: [InterviewService, InterviewPlanService, AnswerInsightService, InterviewCoachingService],
})
export class InterviewModule {}
