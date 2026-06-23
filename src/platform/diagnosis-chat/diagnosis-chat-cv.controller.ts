import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { DiagnosisChatPlatformService } from './diagnosis-chat-platform.service';
import { DiagnosisChatCvOnlyRequestDto } from './dto/diagnosis-chat.dto';

/**
 * CV-only advisor route — a scan the user checked WITHOUT comparing a JD (no match). cvId comes from
 * the PATH (UUID-validated); the platform service builds FACTS from the user's OWN latest CV review and
 * keys the conversation by (userId, cvId). Same auth surface as the JD-match chat controller.
 */
@ApiTags('CVs')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/cvs/:cvId/diagnosis-chat')
export class DiagnosisChatCvController {
  constructor(private readonly diagnosisChat: DiagnosisChatPlatformService) {}

  @Post()
  @ApiOperation({
    summary: 'Ask the grounded CV-diagnosis advisor a question about a CV-only scan (no JD match)',
  })
  @ApiParam({ name: 'cvId', format: 'uuid' })
  turn(
    @CurrentUser() user: JwtUser,
    @Param('cvId', new ParseUUIDPipe()) cvId: string,
    @Body() dto: DiagnosisChatCvOnlyRequestDto,
  ) {
    return this.diagnosisChat.turnCvOnly(user.userId, cvId, dto);
  }
}
