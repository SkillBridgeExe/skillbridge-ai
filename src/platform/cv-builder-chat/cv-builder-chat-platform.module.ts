import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import { CvBuilderChatModule } from '../../modules/cv-builder-chat/cv-builder-chat.module';
import { CvsModule } from '../cvs/cvs.module';
import { CvBuilderChatController } from './cv-builder-chat.controller';
import { CvBuilderChatPlatformService } from './cv-builder-chat-platform.service';

// LlmModule / PromptsModule / TracingModule are @Global() — injected without explicit import,
// matching diagnosis-chat.module.ts. CvBuilderChatModule (LLM phrasing) lives in the AI lane; this
// platform module owns persistence + quota + tracing + ownership-scoped FACTS.
@Module({
  imports: [
    TypeOrmModule.forFeature([ChatConversationEntity, ChatMessageEntity]),
    CvBuilderChatModule,
    CvsModule,
  ],
  controllers: [CvBuilderChatController],
  providers: [CvBuilderChatPlatformService],
})
export class CvBuilderChatPlatformModule {}
