import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { StartInterviewRequestDto, StartInterviewResponseDto } from './dto/start-interview.dto';
import { AnswerInterviewRequestDto, AnswerInterviewResponseDto } from './dto/answer-interview.dto';
import {
  EndInterviewParsedResponse,
  EndInterviewRequestDto,
  EndInterviewResponseDto,
} from './dto/end-interview.dto';

/**
 * Owns the LLM-side of the interview flow:
 *   - /start:  generate first question (with optional CV context for personalisation)
 *   - /answer: produce next question + per-question scoring
 *   - /end:    aggregate full-session scoring + AI feedback
 *
 * The .NET BFF owns the DB lifecycle (interview_sessions, interview_questions).
 * This service writes only to ai_requests / ai_results.
 */
@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
  ) {}

  async start(userId: string, input: StartInterviewRequestDto): Promise<StartInterviewResponseDto> {
    const template = this.prompts.get(input.prompt_template_code);
    const userPrompt = this.prompts.render(input.prompt_template_code, {
      topic: input.topic,
      language: input.language,
      interview_type: input.interview_type,
      cv_context: input.cv_context ?? '(no CV provided)',
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'interview_start',
      requestPayload: { session_id: input.session_id },
    });

    const llmResult = await this.llm.complete(
      [
        { role: 'system', content: template.meta.system ?? '' },
        { role: 'user', content: userPrompt },
      ],
      { jsonMode: true, temperature: 0.4, maxOutputTokens: 800 },
    );

    await this.tracing.completeAiRequest(aiRequestId, {
      promptTokens: llmResult.tokenUsage.promptTokens,
      completionTokens: llmResult.tokenUsage.completionTokens,
      totalTokens: llmResult.tokenUsage.totalTokens,
      latencyMs: llmResult.latencyMs,
      status: 'SUCCESS',
    });

    const parsed = (llmResult.parsedJson ?? {}) as {
      first_message?: string;
      first_question?: string;
      phase?: StartInterviewResponseDto['phase'];
      total_questions_planned?: number;
    };

    return {
      ai_request_id: aiRequestId,
      first_message: parsed.first_message ?? '',
      first_question: parsed.first_question ?? '',
      phase: parsed.phase ?? 'INTRODUCTION',
      total_questions_planned: parsed.total_questions_planned ?? 7,
      token_usage: llmResult.tokenUsage.totalTokens,
    };
  }

  async answer(
    userId: string,
    input: AnswerInterviewRequestDto,
  ): Promise<AnswerInterviewResponseDto> {
    // For incremental scoring we reuse the same template as start; in a
    // production setup we'd have a separate `interview_answer_v1` template.
    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      requestType: 'interview_answer',
      requestPayload: { session_id: input.session_id, order: input.current_question_order },
    });

    const llmResult = await this.llm.complete(
      [
        {
          role: 'system',
          content:
            'You are a structured interviewer. Score the current answer 0-100 and produce ONE follow-up question (or null if interview should end). Return JSON.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            history: input.question_history,
            current_answer: input.current_user_answer,
            current_order: input.current_question_order,
          }),
        },
      ],
      { jsonMode: true, temperature: 0.4, maxOutputTokens: 600 },
    );

    await this.tracing.completeAiRequest(aiRequestId, {
      promptTokens: llmResult.tokenUsage.promptTokens,
      completionTokens: llmResult.tokenUsage.completionTokens,
      totalTokens: llmResult.tokenUsage.totalTokens,
      latencyMs: llmResult.latencyMs,
      status: 'SUCCESS',
    });

    const parsed = (llmResult.parsedJson ?? {}) as Partial<AnswerInterviewResponseDto>;

    return {
      ai_request_id: aiRequestId,
      ai_message: parsed.ai_message ?? '',
      next_question: parsed.next_question ?? null,
      phase: parsed.phase ?? 'TECHNICAL_DEEP_DIVE',
      finished: parsed.finished ?? false,
      per_question_score: parsed.per_question_score ?? 0,
      per_question_strengths: parsed.per_question_strengths ?? [],
      per_question_improvements: parsed.per_question_improvements ?? [],
    };
  }

  async end(userId: string, input: EndInterviewRequestDto): Promise<EndInterviewResponseDto> {
    const template = this.prompts.get(input.scoring_template_code);
    const userPrompt = this.prompts.render(input.scoring_template_code, {
      questions: input.all_questions_answers,
      duration_seconds: input.duration_seconds,
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'interview_end',
      requestPayload: { session_id: input.session_id },
    });

    const llmResult = await this.llm.complete(
      [
        { role: 'system', content: template.meta.system ?? '' },
        { role: 'user', content: userPrompt },
      ],
      { jsonMode: true, temperature: 0.2, maxOutputTokens: 3000 },
    );

    await this.tracing.completeAiRequest(aiRequestId, {
      promptTokens: llmResult.tokenUsage.promptTokens,
      completionTokens: llmResult.tokenUsage.completionTokens,
      totalTokens: llmResult.tokenUsage.totalTokens,
      latencyMs: llmResult.latencyMs,
      status: 'SUCCESS',
    });

    const parsed = (llmResult.parsedJson ?? {}) as EndInterviewParsedResponse;

    await this.tracing.saveAiResult({
      aiRequestId,
      userId,
      resultType: 'interview_scoring',
      rawResponse: llmResult.rawResponse,
      parsedResponse: parsed,
      totalScore: parsed.overall_score ?? 0,
      tokenUsage: llmResult.tokenUsage.totalTokens,
    });

    return {
      ai_request_id: aiRequestId,
      parsed_response: parsed,
      token_usage: llmResult.tokenUsage.totalTokens,
    };
  }
}
