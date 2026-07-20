import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CvBuilderChatPlatformService } from './cv-builder-chat-platform.service';
import { CvBuilderChatRequestDto } from './dto/cv-builder-chat.dto';

/**
 * CV-builder chat companion route — cvId comes from the PATH (UUID-validated); the platform service
 * builds FACTS from the user's OWN open draft and keys the conversation by (userId, cvId,
 * purpose='cv_builder'). Same auth surface as the diagnosis CV-only chat controller.
 */
@ApiTags('CVs')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/cvs/:cvId/builder/chat')
export class CvBuilderChatController {
  constructor(private readonly cvBuilderChat: CvBuilderChatPlatformService) {}

  @Post()
  @ApiOperation({
    summary: 'Ask the grounded CV-builder companion a question about the open draft',
  })
  @ApiParam({ name: 'cvId', format: 'uuid' })
  turn(
    @CurrentUser() user: JwtUser,
    @Param('cvId', new ParseUUIDPipe()) cvId: string,
    @Body() dto: CvBuilderChatRequestDto,
  ) {
    return this.cvBuilderChat.turn(user.userId, cvId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Restore the persisted CV-builder chat thread' })
  @ApiParam({ name: 'cvId', format: 'uuid' })
  getThread(@CurrentUser() user: JwtUser, @Param('cvId', new ParseUUIDPipe()) cvId: string) {
    return this.cvBuilderChat.getThread(user.userId, cvId);
  }

  @Delete()
  @ApiOperation({ summary: 'Delete the CV-builder chat thread' })
  @ApiParam({ name: 'cvId', format: 'uuid' })
  deleteThread(@CurrentUser() user: JwtUser, @Param('cvId', new ParseUUIDPipe()) cvId: string) {
    return this.cvBuilderChat.deleteThread(user.userId, cvId);
  }
}
