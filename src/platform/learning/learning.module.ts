import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import { LearningRoadmapEntity } from '../../database/entities/learning-roadmap.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { ChatService } from '../../modules/learning-chat/learning-chat.service';
import { RoadmapModule } from '../../modules/roadmap/roadmap.module';
import { CvMatchesModule } from '../cv-matches/cv-matches.module';
import {
  LearningChatController,
  LearningDisplayTranslationController,
  LearningRoadmapController,
  LearningSessionProgressController,
} from './learning.controller';
import { LearningChatPlatformService } from './learning-chat-platform.service';
import { LearningRoadmapPlatformService } from './learning-roadmap.service';
import { LearningSessionProgressService } from './session-progress.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ChatConversationEntity,
      ChatMessageEntity,
      LearningRoadmapEntity,
      LearningSessionProgressEntity,
    ]),
    RoadmapModule,
    forwardRef(() => CvMatchesModule),
  ],
  controllers: [
    LearningChatController,
    LearningSessionProgressController,
    LearningRoadmapController,
    LearningDisplayTranslationController,
  ],
  providers: [
    ChatService,
    LearningChatPlatformService,
    LearningSessionProgressService,
    LearningRoadmapPlatformService,
  ],
})
export class LearningModule {}
