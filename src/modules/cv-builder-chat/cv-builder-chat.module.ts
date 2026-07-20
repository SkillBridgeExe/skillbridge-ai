import { Module } from '@nestjs/common';
import { CvBuilderChatService } from './cv-builder-chat.service';

// LlmModule / PromptsModule are @Global() — injected without an explicit import here, same as
// diagnosis-chat.module.ts. CV-builder tools are dormant per spec (no tool loop), so this AI-lane
// module has no other dependency: no ToolsModule, no persistence (the platform layer owns that).
@Module({
  providers: [CvBuilderChatService],
  exports: [CvBuilderChatService],
})
export class CvBuilderChatModule {}
