import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { LearningRoadmapEntity } from '../../database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../database/entities/learning-roadmap-version.entity';
import { LearningScheduleProfileEntity } from '../../database/entities/learning-schedule-profile.entity';
import { LearningAvailabilitySlotEntity } from '../../database/entities/learning-availability-slot.entity';
import { LearningModuleEntity } from '../../database/entities/learning-module.entity';
import { LearningSessionEntity } from '../../database/entities/learning-session.entity';
import { LearningQuizAttemptEntity } from '../../database/entities/learning-quiz-attempt.entity';
import { LearningEvidenceEntity } from '../../database/entities/learning-evidence.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { ChatService } from '../../modules/learning-chat/learning-chat.service';
import { RoadmapModule } from '../../modules/roadmap/roadmap.module';
import { CvMatchesModule } from '../cv-matches/cv-matches.module';
import {
  LearningChatController,
  LearningDisplayController,
  LearningSessionProgressController,
} from './learning.controller';
import { LearningChatPlatformService } from './learning-chat-platform.service';
import { LearningSessionProgressService } from './session-progress.service';
import { LearningRoadmapsController } from './roadmaps.controller';
import { LearningRoadmapDraftService } from './roadmap-draft.service';
import { LearningRoadmapGenerationService } from './roadmap-generation.service';
import { BillingModule } from '../billing/billing.module';
import { LearningRoadmapQueryService } from './roadmap-query.service';
import { LearningSessionCompletionService } from './session-completion.service';
import { LearningContentEnhancer } from './learning-content-enhancer';
import { LearningRoadmapRescheduleService } from './roadmap-reschedule.service';
import { LearningDisplayTranslationService } from './learning-display-translation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ChatConversationEntity,
      ChatMessageEntity,
      LearningSessionProgressEntity,
      LearningRoadmapEntity,
      LearningRoadmapVersionEntity,
      LearningScheduleProfileEntity,
      LearningAvailabilitySlotEntity,
      LearningModuleEntity,
      LearningSessionEntity,
      LearningQuizAttemptEntity,
      LearningEvidenceEntity,
      CvEntity,
    ]),
    RoadmapModule,
    BillingModule,
    forwardRef(() => CvMatchesModule),
  ],
  controllers: [
    LearningChatController,
    LearningSessionProgressController,
    LearningDisplayController,
    LearningRoadmapsController,
  ],
  providers: [
    ChatService,
    LearningChatPlatformService,
    LearningSessionProgressService,
    LearningRoadmapDraftService,
    LearningRoadmapGenerationService,
    LearningRoadmapQueryService,
    LearningSessionCompletionService,
    LearningContentEnhancer,
    LearningRoadmapRescheduleService,
    LearningDisplayTranslationService,
  ],
})
export class LearningModule {}
