import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { ChatService } from '../../modules/learning-chat/learning-chat.service';
import { RoadmapModule } from '../../modules/roadmap/roadmap.module';
import { CvMatchesModule } from '../cv-matches/cv-matches.module';
import { LearningChatController, LearningSessionProgressController } from './learning.controller';
import { LearningChatPlatformService } from './learning-chat-platform.service';
import { LearningSessionProgressService } from './session-progress.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatConversationEntity, ChatMessageEntity, LearningSessionProgressEntity]),
    RoadmapModule,
    forwardRef(() => CvMatchesModule),
  ],
  controllers: [LearningChatController, LearningSessionProgressController],
  providers: [ChatService, LearningChatPlatformService, LearningSessionProgressService],
})
export class LearningModule {}
