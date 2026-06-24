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
import { coerceInterviewGapItems } from './interview-gap';
import { maskPiiDeep } from '../../common/services/pii-mask';

const SCORE_0_100 = { type: 'number', minimum: 0, maximum: 100 };
const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

const INTERVIEW_SCORING_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overall_score',
    'semantic_score',
    'llm_score',
    'communication_score',
    'ai_feedback',
    'per_question_scores',
    'interview_gap_items',
  ],
  properties: {
    overall_score: SCORE_0_100,
    semantic_score: SCORE_0_100,
    llm_score: SCORE_0_100,
    communication_score: SCORE_0_100,
    ai_feedback: {
      type: 'object',
      additionalProperties: false,
      required: [
        'summary',
        'technical_delivery',
        'communication_flow',
        'body_language',
        'recommendations',
        'suggested_modules',
      ],
      properties: {
        summary: { type: 'string' },
        technical_delivery: {
          type: 'object',
          additionalProperties: false,
          required: ['concept_accuracy', 'problem_solving', 'system_thinking', 'code_quality'],
          properties: {
            concept_accuracy: SCORE_0_100,
            problem_solving: SCORE_0_100,
            system_thinking: SCORE_0_100,
            code_quality: SCORE_0_100,
          },
        },
        communication_flow: {
          type: 'object',
          additionalProperties: false,
          required: ['articulation', 'listening_response', 'filler_words', 'structured_answers'],
          properties: {
            articulation: SCORE_0_100,
            listening_response: SCORE_0_100,
            filler_words: SCORE_0_100,
            structured_answers: SCORE_0_100,
          },
        },
        body_language: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['eye_contact', 'posture', 'gestures', 'facial_expressions'],
          properties: {
            eye_contact: SCORE_0_100,
            posture: SCORE_0_100,
            gestures: SCORE_0_100,
            facial_expressions: SCORE_0_100,
          },
        },
        recommendations: { type: 'string' },
        suggested_modules: STRING_ARRAY,
      },
    },
    per_question_scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'question_order',
          'question',
          'answer',
          'ai_score',
          'strengths',
          'improvements',
          'time_taken_seconds',
        ],
        properties: {
          question_order: { type: 'integer', minimum: 1 },
          question: { type: 'string' },
          answer: { type: 'string' },
          ai_score: SCORE_0_100,
          strengths: STRING_ARRAY,
          improvements: STRING_ARRAY,
          time_taken_seconds: { type: 'number', minimum: 0 },
        },
      },
    },
    interview_gap_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'target_type',
          'skill_canonical',
          'display_name',
          'weakness_type',
          'severity',
          'evidence_from_answer',
          'recommended_action',
          'linked_question_id',
        ],
        properties: {
          target_type: {
            type: 'string',
            enum: ['skill', 'evidence', 'communication', 'behavioral', 'role_fit'],
          },
          skill_canonical: { type: ['string', 'null'] },
          display_name: { type: 'string' },
          weakness_type: {
            type: 'string',
            enum: [
              'knowledge_gap',
              'evidence_gap',
              'communication_gap',
              'behavioral_gap',
              'role_fit_risk',
            ],
          },
          severity: { type: 'number', minimum: 0, maximum: 1 },
          evidence_from_answer: { type: 'string', maxLength: 280 },
          recommended_action: { type: 'string' },
          linked_question_id: { type: ['string', 'null'] },
        },
      },
    },
  },
};

/**
 * Owns the LLM-side of the interview flow:
 *   - /start:  generate first question (with optional CV context for personalisation)
 *   - /answer: produce next question + per-question scoring
 *   - /end:    aggregate full-session scoring + AI feedback
 *
 * The platform layer (NestJS, src/platform) owns the DB lifecycle (interview_sessions, interview_questions).
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

    const startedAt = Date.now();
    try {
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
        estimatedCost: llmResult.estimatedCostUsd,
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
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      throw err;
    }
  }

  async answer(
    userId: string,
    input: AnswerInterviewRequestDto,
  ): Promise<AnswerInterviewResponseDto> {
    const template = this.prompts.get('interview_answer_v1');
    const userPrompt = this.prompts.render('interview_answer_v1', {
      history: JSON.stringify(input.question_history),
      current_answer: input.current_user_answer,
      current_order: input.current_question_order,
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'interview_answer',
      requestPayload: { session_id: input.session_id, order: input.current_question_order },
    });

    const startedAt = Date.now();
    try {
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        { jsonMode: true, temperature: 0.4, maxOutputTokens: 600 },
      );

      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: llmResult.tokenUsage.totalTokens,
        estimatedCost: llmResult.estimatedCostUsd,
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
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      throw err;
    }
  }

  async end(userId: string, input: EndInterviewRequestDto): Promise<EndInterviewResponseDto> {
    const template = this.prompts.get(input.scoring_template_code);
    const maskedQuestions = maskPiiDeep(input.all_questions_answers);
    const userPrompt = this.prompts.render(input.scoring_template_code, {
      questions: maskedQuestions,
      duration_seconds: input.duration_seconds,
      probed_skills: input.probed_skills ?? '',
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'interview_end',
      requestPayload: { session_id: input.session_id },
    });

    const startedAt = Date.now();
    try {
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          jsonMode: true,
          responseSchema: INTERVIEW_SCORING_RESPONSE_SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 3000,
        },
      );

      const rawParsed = (llmResult.parsedJson ?? {}) as Record<string, unknown>;
      const parsed = {
        ...(rawParsed as unknown as EndInterviewParsedResponse),
        interview_gap_items: coerceInterviewGapItems(rawParsed.interview_gap_items),
      };

      // Persist the result BEFORE marking SUCCESS (audit invariant: SUCCESS ⇒ has result).
      await this.tracing.saveAiResult({
        aiRequestId,
        userId,
        resultType: 'interview_scoring',
        rawResponse: maskPiiDeep(llmResult.rawResponse),
        parsedResponse: maskPiiDeep(parsed),
        totalScore: parsed.overall_score ?? 0,
        tokenUsage: llmResult.tokenUsage.totalTokens,
      });

      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: llmResult.tokenUsage.totalTokens,
        estimatedCost: llmResult.estimatedCostUsd,
        latencyMs: llmResult.latencyMs,
        status: 'SUCCESS',
      });

      return {
        ai_request_id: aiRequestId,
        parsed_response: parsed,
        token_usage: llmResult.tokenUsage.totalTokens,
      };
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      throw err;
    }
  }
}
