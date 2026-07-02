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
import { DiagnosisChatPlatformService } from './diagnosis-chat-platform.service';
import { DiagnosisChatRequestDto } from './dto/diagnosis-chat.dto';

@ApiTags('CV Matches')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/cv-matches/:matchId/chat')
export class DiagnosisChatController {
  constructor(private readonly diagnosisChat: DiagnosisChatPlatformService) {}

  @Post()
  @ApiOperation({
    summary: 'Ask the grounded CV-diagnosis advisor a question about a CV/JD match',
  })
  @ApiParam({ name: 'matchId', format: 'uuid' })
  turn(
    @CurrentUser() user: JwtUser,
    @Param('matchId', new ParseUUIDPipe()) matchId: string,
    @Body() dto: DiagnosisChatRequestDto,
  ) {
    return this.diagnosisChat.turn(user.userId, matchId, dto);
  }

  @Get('thread')
  @ApiOperation({ summary: 'Get the persisted diagnosis chat thread for a CV/JD match' })
  @ApiParam({ name: 'matchId', format: 'uuid' })
  getThread(@CurrentUser() user: JwtUser, @Param('matchId', new ParseUUIDPipe()) matchId: string) {
    return this.diagnosisChat.getThread(user.userId, matchId);
  }

  @Delete('thread')
  @ApiOperation({ summary: 'Delete the persisted diagnosis chat thread for a CV/JD match' })
  @ApiParam({ name: 'matchId', format: 'uuid' })
  deleteThread(
    @CurrentUser() user: JwtUser,
    @Param('matchId', new ParseUUIDPipe()) matchId: string,
  ) {
    return this.diagnosisChat.deleteThread(user.userId, matchId);
  }
}
