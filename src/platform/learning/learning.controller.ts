import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { LearningChatRequestDto } from './dto/learning-chat.dto';
import {
  AnswerLearningQuizQuestionDto,
  PatchLearningChecklistItemDto,
  UpdateLearningSessionProgressDto,
} from './dto/session-progress.dto';
import { LearningChatPlatformService } from './learning-chat-platform.service';
import { LearningSessionProgressService } from './session-progress.service';
import { LearningSessionCompletionService } from './session-completion.service';
import { TranslateLearningDisplayDto } from './dto/roadmap.dto';
import { LearningDisplayTranslationService } from './learning-display-translation.service';

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
  constructor(
    private readonly sessionProgress: LearningSessionProgressService,
    private readonly sessionCompletion: LearningSessionCompletionService,
  ) {}

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

  @Post(':sessionId/complete')
  @ApiOperation({ summary: 'Validate and complete an available learning session' })
  complete(@CurrentUser() user: JwtUser, @Param('sessionId') sessionId: string) {
    return this.sessionCompletion.complete(user.userId, sessionId);
  }

  @Post(':sessionId/quiz/answer')
  @ApiOperation({ summary: 'Score one quiz answer for a learning session' })
  answerQuizQuestion(
    @CurrentUser() user: JwtUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: AnswerLearningQuizQuestionDto,
  ) {
    return this.sessionProgress.answerQuizQuestion(user.userId, sessionId, dto);
  }

  @Get(':sessionId/next-questions')
  @ApiOperation({ summary: 'Get adaptive next quiz questions for weak lesson objectives' })
  getNextQuestions(
    @CurrentUser() user: JwtUser,
    @Param('sessionId') sessionId: string,
    @Query('skill') skillCanonical: string,
  ) {
    return this.sessionProgress.getNextQuestions(user.userId, sessionId, skillCanonical);
  }

  @Put(':sessionId/checklist/:itemId')
  @ApiOperation({ summary: 'Patch one checklist item without overwriting full lesson progress' })
  patchChecklistItem(
    @CurrentUser() user: JwtUser,
    @Param('sessionId') sessionId: string,
    @Param('itemId') itemId: string,
    @Body() dto: PatchLearningChecklistItemDto,
  ) {
    return this.sessionProgress.patchChecklistItem(user.userId, sessionId, itemId, dto);
  }
}

@ApiTags('Learning')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/learning')
export class LearningDisplayController {
  constructor(private readonly translation: LearningDisplayTranslationService) {}

  @Post('translate-display')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Translate transient Learning UI text without persistence' })
  translate(@Body() dto: TranslateLearningDisplayDto) {
    return this.translation.translateMany(
      dto.items.map((item) => ({ ...item, locale: dto.locale })),
    );
  }
}
