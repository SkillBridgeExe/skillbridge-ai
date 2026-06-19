import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import {
  AnswerPlatformInterviewDto,
  EndPlatformInterviewDto,
  InterviewListQueryDto,
  StartPlatformInterviewDto,
} from './dto/interview.dto';
import { InterviewGapReportService } from './interview-gap-report.service';
import { InterviewsService } from './interviews.service';

@ApiTags('Interviews')
@ApiBearerAuth()
@Public()
@UseGuards(AuthGuard('jwt'))
@Controller('api/interview')
export class InterviewsController {
  constructor(
    private readonly interviews: InterviewsService,
    private readonly interviewGapReport: InterviewGapReportService,
  ) {}

  @Post('start')
  @ApiOperation({
    summary: 'Start a CV/JD-backed mock interview session',
    description:
      'Creates a persisted interview session, asks the first question, and returns an OpenAI Realtime client secret for voice/hybrid modes when configured.',
  })
  start(@CurrentUser() user: JwtUser, @Body() body: StartPlatformInterviewDto) {
    return this.interviews.start(user.userId, body);
  }

  @Post('turn')
  @ApiOperation({
    summary: 'Submit one text/transcript answer and receive the next interview question',
  })
  turn(@CurrentUser() user: JwtUser, @Body() body: AnswerPlatformInterviewDto) {
    return this.interviews.answer(user.userId, body);
  }

  @Post('end')
  @ApiOperation({ summary: 'End an interview session and generate final scoring feedback' })
  end(@CurrentUser() user: JwtUser, @Body() body: EndPlatformInterviewDto) {
    return this.interviews.end(user.userId, body);
  }

  @Get('history')
  @ApiOperation({ summary: 'List interview sessions for the authenticated user' })
  history(@CurrentUser() user: JwtUser, @Query() query: InterviewListQueryDto) {
    return this.interviews.list(user.userId, query);
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: 'Get one interview session with all persisted turns' })
  @ApiParam({ name: 'id', format: 'uuid' })
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.interviews.get(user.userId, id);
  }

  @Get('sessions/:id/gap-report')
  @ApiOperation({
    summary: 'Get the structured InterviewGapReport for a finished session',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  gapReport(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.interviewGapReport.get(user.userId, id);
  }

  @Post('sessions/:id/realtime-token')
  @ApiOperation({ summary: 'Refresh the OpenAI Realtime client secret for an active session' })
  @ApiParam({ name: 'id', format: 'uuid' })
  realtimeToken(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.interviews.createRealtimeToken(user.userId, id);
  }

  @Post('sessions/:id/question-audio')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create speech audio for the current server-owned question' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async questionAudio(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const audio = await this.interviews.createQuestionAudio(user.userId, id);
    return new StreamableFile(audio.data, {
      type: audio.contentType,
      disposition: 'inline; filename="interview-question.mp3"',
    });
  }
}
