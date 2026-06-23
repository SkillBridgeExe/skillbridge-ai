import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
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
    @Param('matchId') matchId: string,
    @Body() dto: DiagnosisChatRequestDto,
  ) {
    return this.diagnosisChat.turn(user.userId, matchId, dto);
  }
}
