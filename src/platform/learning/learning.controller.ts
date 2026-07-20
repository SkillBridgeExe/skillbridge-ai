import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { PatchRoadmapScheduleDto, TranslateDisplayRequestDto } from './dto/learning-roadmap.dto';
import { LearningChatPlatformService } from './learning-chat-platform.service';
import { LearningSessionProgressService } from './session-progress.service';
import { LearningRoadmapPlatformService } from './learning-roadmap.service';

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
@Controller('api/learning/roadmaps')
export class LearningRoadmapController {
  constructor(private readonly roadmaps: LearningRoadmapPlatformService) {}

  @Get('active')
  @ApiOperation({ summary: 'Get the active persisted learning roadmap' })
  getActive(@CurrentUser() user: JwtUser) {
    return this.roadmaps.getActive(user.userId);
  }

  @Delete('active')
  @ApiOperation({ summary: 'Clear the current user learning roadmap and session progress' })
  clearActive(@CurrentUser() user: JwtUser) {
    return this.roadmaps.clearActive(user.userId);
  }

  @Patch(':roadmapId/schedule')
  @ApiOperation({ summary: 'Patch the persisted learning roadmap schedule' })
  patchSchedule(
    @CurrentUser() user: JwtUser,
    @Param('roadmapId') roadmapId: string,
    @Body() dto: PatchRoadmapScheduleDto,
  ) {
    return this.roadmaps.patchSchedule(user.userId, roadmapId, dto.schedule);
  }
}

@ApiTags('Learning')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/learning')
export class LearningDisplayTranslationController {
  constructor(private readonly roadmaps: LearningRoadmapPlatformService) {}

  @Post('translate-display')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Translate short learning display text on demand' })
  translateDisplay(@Body() dto: TranslateDisplayRequestDto) {
    return this.roadmaps.translateDisplayItems(dto);
  }
}
