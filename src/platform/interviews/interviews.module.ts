import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { InterviewRealtimeDirectiveEntity } from '../../database/entities/interview-realtime-directive.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { InterviewQuestionBankItemEntity } from '../../database/entities/interview-question-bank-item.entity';
import { InterviewModule } from '../../modules/interview/interview.module';
import { BillingModule } from '../billing/billing.module';
import { CvMatchesModule } from '../cv-matches/cv-matches.module';
import { InterviewsController } from './interviews.controller';
import { InterviewChainLlmService } from './interview-chain-llm.service';
import { InterviewGapReportService } from './interview-gap-report.service';
import { InterviewRealtimeService } from './interview-realtime.service';
import { InterviewTurnPolicyService } from './interview-turn-policy.service';
import { InterviewsService } from './interviews.service';
import { OpenAiQuestionAudioService } from './openai-question-audio.service';
import { OpenAiRealtimeTokenService } from './openai-realtime-token.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InterviewSessionEntity,
      InterviewTurnEntity,
      InterviewRealtimeDirectiveEntity,
      CvEntity,
      CvMatchEntity,
      JobDescriptionEntity,
      AiResultEntity,
      InterviewQuestionBankItemEntity,
    ]),
    InterviewModule,
    BillingModule,
    forwardRef(() => CvMatchesModule),
  ],
  controllers: [InterviewsController],
  providers: [
    InterviewsService,
    OpenAiRealtimeTokenService,
    OpenAiQuestionAudioService,
    InterviewGapReportService,
    InterviewChainLlmService,
    InterviewRealtimeService,
    InterviewTurnPolicyService,
  ],
  exports: [InterviewGapReportService],
})
export class InterviewsModule {}
