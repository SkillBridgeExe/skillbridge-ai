import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { LearningChatRequestDto } from './dto/learning-chat.dto';
import { LearningChatPlatformService } from './learning-chat-platform.service';

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
