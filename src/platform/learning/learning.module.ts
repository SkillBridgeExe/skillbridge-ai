import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import { ChatService } from '../../modules/learning-chat/learning-chat.service';
import { RoadmapModule } from '../../modules/roadmap/roadmap.module';
import { CvMatchesModule } from '../cv-matches/cv-matches.module';
import { LearningChatController } from './learning.controller';
import { LearningChatPlatformService } from './learning-chat-platform.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatConversationEntity, ChatMessageEntity]),
    RoadmapModule,
    forwardRef(() => CvMatchesModule),
  ],
  controllers: [LearningChatController],
  providers: [ChatService, LearningChatPlatformService],
})
export class LearningModule {}
