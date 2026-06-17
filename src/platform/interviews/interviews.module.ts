import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { InterviewModule } from '../../modules/interview/interview.module';
import { BillingModule } from '../billing/billing.module';
import { CvMatchesModule } from '../cv-matches/cv-matches.module';
import { InterviewsController } from './interviews.controller';
import { InterviewsService } from './interviews.service';
import { OpenAiQuestionAudioService } from './openai-question-audio.service';
import { OpenAiRealtimeTokenService } from './openai-realtime-token.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InterviewSessionEntity,
      InterviewTurnEntity,
      CvEntity,
      CvMatchEntity,
      JobDescriptionEntity,
    ]),
    InterviewModule,
    BillingModule,
    CvMatchesModule,
  ],
  controllers: [InterviewsController],
  providers: [InterviewsService, OpenAiRealtimeTokenService, OpenAiQuestionAudioService],
})
export class InterviewsModule {}
