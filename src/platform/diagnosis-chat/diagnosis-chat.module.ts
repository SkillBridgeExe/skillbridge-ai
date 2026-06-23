import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import { DiagnosisChatService } from '../../modules/diagnosis-chat/diagnosis-chat.service';
import { CvMatchesModule } from '../cv-matches/cv-matches.module';
import { CvsModule } from '../cvs/cvs.module';
import { DiagnosisChatController } from './diagnosis-chat.controller';
import { DiagnosisChatPlatformService } from './diagnosis-chat-platform.service';

// LlmModule / PromptsModule / TracingModule are @Global() — injected without explicit import,
// matching LearningModule. DiagnosisChatService (LLM phrasing) lives in the AI lane; this platform
// module owns persistence + quota + tracing + ownership-scoped FACTS.
@Module({
  imports: [
    TypeOrmModule.forFeature([ChatConversationEntity, ChatMessageEntity]),
    forwardRef(() => CvMatchesModule),
    CvsModule,
  ],
  controllers: [DiagnosisChatController],
  providers: [DiagnosisChatService, DiagnosisChatPlatformService],
})
export class DiagnosisChatModule {}
