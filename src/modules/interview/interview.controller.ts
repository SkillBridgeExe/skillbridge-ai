import { Body, Controller, Post } from '@nestjs/common';
import { CorrelationId } from '../../common/decorators/correlation-id.decorator';
import { InternalUser } from '../../common/decorators/internal-user.decorator';
import { InterviewService } from './interview.service';
import { InterviewPlanService } from './interview-plan.service';
import { StartInterviewRequestDto, StartInterviewResponseDto } from './dto/start-interview.dto';
import { AnswerInterviewRequestDto, AnswerInterviewResponseDto } from './dto/answer-interview.dto';
import { EndInterviewRequestDto, EndInterviewResponseDto } from './dto/end-interview.dto';
import { InterviewPlanRequestDto, InterviewPlanResponseDto } from './dto/interview-plan.dto';

@Controller('internal/ai/interview')
export class InterviewController {
  constructor(
    private readonly service: InterviewService,
    private readonly planService: InterviewPlanService,
  ) {}

  /** POST /internal/ai/interview/start */
  @Post('start')
  start(
    @InternalUser() userId: string,
    @CorrelationId() _cid: string,
    @Body() body: StartInterviewRequestDto,
  ): Promise<StartInterviewResponseDto> {
    return this.service.start(userId, body);
  }

  /** POST /internal/ai/interview/answer */
  @Post('answer')
  answer(
    @InternalUser() userId: string,
    @CorrelationId() _cid: string,
    @Body() body: AnswerInterviewRequestDto,
  ): Promise<AnswerInterviewResponseDto> {
    return this.service.answer(userId, body);
  }

  /** POST /internal/ai/interview/end */
  @Post('end')
  end(
    @InternalUser() userId: string,
    @CorrelationId() _cid: string,
    @Body() body: EndInterviewRequestDto,
  ): Promise<EndInterviewResponseDto> {
    return this.service.end(userId, body);
  }

  /** POST /internal/ai/interview/plan — gap-targeted prep pack (platform fronts this via /api). */
  @Post('plan')
  plan(
    @InternalUser() userId: string,
    @CorrelationId() _cid: string,
    @Body() body: InterviewPlanRequestDto,
  ): Promise<InterviewPlanResponseDto> {
    return this.planService.generatePlan(userId, body);
  }
}
