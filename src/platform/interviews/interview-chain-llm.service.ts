import { Injectable } from '@nestjs/common';
import { maskPiiDeep } from '../../common/services/pii-mask';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../../modules/prompts/prompts.service';
import { TracingService } from '../../modules/tracing/tracing.service';
import { DepthSignal, TurnAction } from '../../modules/interview/interview-agenda';

const PROMPT_ASSESS = 'interview_assess_v1';
const PROMPT_ASK = 'interview_ask_v1';
const ASSESS_SEED = 20260621;

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

export const INTERVIEW_ASSESS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'score',
    'recognized_concepts',
    'depth_signal',
    'claim_status',
    'current_thread',
    'gaps_revealed',
    'note',
  ],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 100 },
    recognized_concepts: STRING_ARRAY,
    depth_signal: { type: 'string', enum: ['shallow', 'adequate', 'deep', 'evasive'] },
    claim_status: { type: 'string', enum: ['ok', 'partial', 'wrong'] },
    current_thread: { type: 'string' },
    gaps_revealed: STRING_ARRAY,
    note: { type: 'string', maxLength: 240 },
  },
};

export const INTERVIEW_ASK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['ai_message', 'question'],
  properties: {
    ai_message: { type: 'string' },
    question: { type: 'string' },
  },
};

export type ClaimStatus = 'ok' | 'partial' | 'wrong';

export interface InterviewAssessInput {
  sessionId: string;
  turnOrder: number;
  language: 'vi' | 'en';
  seniorityTarget: string;
  currentTopic: unknown;
  targetDimension: string;
  currentThread: string;
  drillDepth: number;
  recentQa: unknown;
}

export interface InterviewAssessOutput {
  aiRequestId: string;
  score: number;
  recognizedConcepts: string[];
  depthSignal: DepthSignal;
  claimStatus: ClaimStatus;
  currentThread: string;
  gapsRevealed: string[];
  note: string;
}

export interface InterviewAskInput {
  sessionId: string;
  turnOrder: number;
  decision: TurnAction | 'opener';
  language: 'vi' | 'en';
  seniorityTarget: string;
  currentTopic: unknown;
  currentThread: string;
  recentQa: unknown;
  runningNotes: string[];
  prevTopicOutcome: string;
}

export interface InterviewAskOutput {
  aiRequestId: string;
  aiMessage: string;
  question: string;
}

@Injectable()
export class InterviewChainLlmService {
  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
  ) {}

  async assess(userId: string, input: InterviewAssessInput): Promise<InterviewAssessOutput> {
    const template = this.prompts.get(PROMPT_ASSESS);
    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: process.env.INTERVIEW_ASSESS_MODEL || 'gpt-4o-mini',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'interview_assess',
      requestPayload: { session_id: input.sessionId, turn_order: input.turnOrder },
    });

    const startedAt = Date.now();
    try {
      const promptVars = maskPiiDeep({
        language: input.language,
        seniority_target: input.seniorityTarget,
        current_topic: JSON.stringify(input.currentTopic),
        target_dimension: input.targetDimension,
        current_thread: input.currentThread,
        drill_depth: input.drillDepth,
        recent_qa: JSON.stringify(input.recentQa),
      });

      const userPrompt = this.prompts.render(PROMPT_ASSESS, promptVars);
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          responseSchema: INTERVIEW_ASSESS_SCHEMA,
          temperature: 0,
          seed: ASSESS_SEED,
          maxOutputTokens: 500,
          model: process.env.INTERVIEW_ASSESS_MODEL || 'gpt-4o-mini',
        },
      );
      const output = coerceAssessOutput(aiRequestId, llmResult.parsedJson);

      await this.tracing.saveAiResult({
        aiRequestId,
        userId,
        resultType: 'interview_assess',
        rawResponse: maskPiiDeep(llmResult.rawResponse),
        parsedResponse: maskPiiDeep(output),
        totalScore: output.score,
        tokenUsage: llmResult.tokenUsage.totalTokens,
      });
      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: llmResult.tokenUsage.totalTokens,
        estimatedCost: llmResult.estimatedCostUsd,
        latencyMs: llmResult.latencyMs,
        status: 'SUCCESS',
        modelCode: llmResult.modelCode,
      });

      return output;
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      throw err;
    }
  }

  async ask(userId: string, input: InterviewAskInput): Promise<InterviewAskOutput> {
    const template = this.prompts.get(PROMPT_ASK);
    const model = process.env.INTERVIEW_ASK_MODEL || 'gpt-4o-mini';
    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: model,
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'interview_ask',
      requestPayload: {
        session_id: input.sessionId,
        turn_order: input.turnOrder,
        decision: input.decision,
      },
    });

    const startedAt = Date.now();
    try {
      const promptVars = maskPiiDeep({
        decision: input.decision,
        language: input.language,
        seniority_target: input.seniorityTarget,
        current_topic: JSON.stringify(input.currentTopic),
        current_thread: input.currentThread,
        recent_qa: JSON.stringify(input.recentQa),
        running_notes: JSON.stringify(input.runningNotes),
        prev_topic_outcome: input.prevTopicOutcome,
      });

      const userPrompt = this.prompts.render(PROMPT_ASK, promptVars);
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          responseSchema: INTERVIEW_ASK_SCHEMA,
          maxOutputTokens: 400,
          model,
        },
      );
      const output = coerceAskOutput(aiRequestId, llmResult.parsedJson);

      await this.tracing.saveAiResult({
        aiRequestId,
        userId,
        resultType: 'interview_ask',
        rawResponse: maskPiiDeep(llmResult.rawResponse),
        parsedResponse: maskPiiDeep(output),
        tokenUsage: llmResult.tokenUsage.totalTokens,
      });
      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: llmResult.tokenUsage.totalTokens,
        estimatedCost: llmResult.estimatedCostUsd,
        latencyMs: llmResult.latencyMs,
        status: 'SUCCESS',
        modelCode: llmResult.modelCode,
      });

      return output;
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      throw err;
    }
  }
}

function coerceAssessOutput(aiRequestId: string, parsed: unknown): InterviewAssessOutput {
  const raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const depthSignal = pickDepthSignal(raw.depth_signal);
  const claimStatus = pickClaimStatus(raw.claim_status);
  return {
    aiRequestId,
    score: clampScore(raw.score),
    recognizedConcepts: stringArray(raw.recognized_concepts),
    depthSignal,
    claimStatus,
    currentThread: stringValue(raw.current_thread),
    gapsRevealed: stringArray(raw.gaps_revealed),
    note: stringValue(raw.note).slice(0, 240),
  };
}

function coerceAskOutput(aiRequestId: string, parsed: unknown): InterviewAskOutput {
  const raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return {
    aiRequestId,
    aiMessage: stringValue(raw.ai_message),
    question: stringValue(raw.question),
  };
}

function clampScore(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function pickDepthSignal(value: unknown): DepthSignal {
  return value === 'adequate' || value === 'deep' || value === 'evasive' ? value : 'shallow';
}

function pickClaimStatus(value: unknown): ClaimStatus {
  return value === 'partial' || value === 'wrong' ? value : 'ok';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
