import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { LearningChatRequestDto } from './dto/learning-chat.dto';
import { UpdateLearningSessionProgressDto } from './dto/session-progress.dto';
import { LearningChatPlatformService } from './learning-chat-platform.service';
import { LearningSessionProgressService } from './session-progress.service';

@ApiTags('Learning')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/learning/chat')
export class LearningChatController {
  constructor(private readonly learningChat: LearningChatPlatformService) {}

  @Post()
  @ApiOperation({ summary: 'Send a grounded learning-chat message' })
  turn(@CurrentUser() user: JwtUser, @Body() dto: LearningChatRequestDto) {
    return this.learningChat.turn(user.userId, dto);
  }

  @Get(':conversationId')
  @ApiOperation({ summary: 'Get learning-chat conversation history' })
  history(@CurrentUser() user: JwtUser, @Param('conversationId') conversationId: string) {
    return this.learningChat.history(user.userId, conversationId);
  }
}

@ApiTags('Learning')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/learning/sessions')
export class LearningSessionProgressController {
  constructor(private readonly sessionProgress: LearningSessionProgressService) {}

  @Get(':sessionId/progress')
  @ApiOperation({ summary: 'Get the current learner progress for one learning session' })
  getProgress(@CurrentUser() user: JwtUser, @Param('sessionId') sessionId: string) {
    return this.sessionProgress.getProgress(user.userId, sessionId);
  }

  @Put(':sessionId/progress')
  @ApiOperation({ summary: 'Save checklist ticks and proof notes for one learning session' })
  saveProgress(
    @CurrentUser() user: JwtUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateLearningSessionProgressDto,
  ) {
    return this.sessionProgress.saveProgress(user.userId, sessionId, dto);
  }
}
