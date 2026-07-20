import { Injectable } from '@nestjs/common';
import { maskPiiDeep } from '../../common/services/pii-mask';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../../modules/prompts/prompts.service';
import { TracingService } from '../../modules/tracing/tracing.service';
import { DepthSignal, DrillLadderRung, TurnAction } from '../../modules/interview/interview-agenda';

const PROMPT_ASSESS = 'interview_assess_v1';
const PROMPT_ASK = 'interview_ask_v1';
const ASSESS_SEED = 20260621;
const MAX_AI_MESSAGE_CHARS = 180;
const MAX_AI_MESSAGE_TOKENS = 28;

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };
const QUESTION_LIKE_MESSAGE_PATTERN =
  /\?|(?:\b(?:can|could|would)\s+you\b)|(?:\b(?:describe|explain|tell\s+me)\b)|(?:\bhow\s+(?:would|do|did|can)\s+you\b)|(?:\bwhat\s+(?:would|do|did|can)\s+you\b)|(?:\bwhy\s+(?:would|do|did|can)\s+you\b)|(?:\bhay\s+mo\s+ta\b)|(?:\bban\s+co\s+the\b)|(?:\bgiai\s+thich\b)|(?:\bcho\s+vai\s+tro\b)/i;
const ENGLISH_QUESTION_START_PATTERN =
  /^(?:can|could|would|do|did|have|has|what|how|why|when|where|describe|explain|tell)\b/i;
const VIETNAMESE_SCRIPT_PATTERN =
  /[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
const VIETNAMESE_MARKER_PATTERN =
  /\b(?:ban|minh|toi|em|anh|chi|khi|trong|mot|nhu|the\s+nao|vi\s+sao|hay|mo\s+ta|giai\s+thich|quan\s+ly|du\s+an|thuc\s+te|luyen\s+tap|kho\s+khan|rut\s+ra|lien\s+quan|vai\s+tro)\b/i;
const TECHNICAL_TOKENS = new Set([
  'ai',
  'api',
  'aws',
  'backend',
  'cache',
  'component',
  'css',
  'database',
  'docker',
  'frontend',
  'gateway',
  'graphql',
  'html',
  'javascript',
  'kubernetes',
  'llm',
  'mongodb',
  'mysql',
  'nestjs',
  'next',
  'node',
  'nodejs',
  'postgres',
  'postgresql',
  'react',
  'redis',
  'rest',
  'schema',
  'sql',
  'state',
  'typescript',
  'useeffect',
  'usestate',
  'vue',
]);
const ENGLISH_COMMON_TOKENS = new Set([
  'a',
  'about',
  'and',
  'can',
  'challenges',
  'choose',
  'could',
  'describe',
  'design',
  'did',
  'do',
  'explain',
  'experience',
  'face',
  'for',
  'gears',
  'great',
  'had',
  'have',
  'how',
  'in',
  'insights',
  'into',
  'let',
  'me',
  'moving',
  'project',
  'specific',
  'shift',
  'tell',
  'that',
  'the',
  'to',
  'us',
  'what',
  'where',
  'with',
  'would',
  'you',
  'your',
]);
const VIETNAMESE_COMMON_TOKENS = new Set([
  'ban',
  'cau',
  'co',
  'da',
  'do',
  'du',
  'em',
  'gap',
  'gi',
  'hay',
  'khi',
  'khan',
  'kho',
  'lam',
  'lien',
  'minh',
  'mot',
  'nao',
  'quan',
  'ra',
  'rut',
  'se',
  'the',
  'toi',
  'trong',
  'vai',
  'voi',
]);

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
  /** I-REAL-2: code-owned drill-ladder rung the next drill/push question must target. */
  ladderRung?: DrillLadderRung | null;
  /** I-REAL-2: agenda topic phase — SCENARIO activates the incident-simulation instruction. */
  topicPhase?: string | null;
  /** I-INTEL: concept from the candidate's LAST answer the drill/push question must anchor on. */
  drillAnchor?: string | null;
  /** I-INTEL: the last answer had nothing concrete — demand ONE real example instead. */
  demandExample?: boolean;
  /** I-OWN: the last answer described work without measuring it — demand the number. */
  demandMetric?: boolean;
}

/** rung → what the next drill/push question must target (CODE-owned, mirrors the ladder). */
const DRILL_FOCUS: Record<DrillLadderRung, string> = {
  application:
    'target HOW they actually did or would do it — concrete steps, real commands, code-level detail',
  tradeoff: 'target WHY — the alternatives they rejected and the trade-off that decided it',
  edge_failure:
    'target WHERE IT BREAKS — edge cases, failure modes, and what they would monitor for it',
  design:
    'target SCALE AND DESIGN — how the approach must change at 10x load or under new constraints',
  reflection:
    'target HINDSIGHT — what they would do differently if they did it again, and what specifically ' +
    'taught them that',
  decision_ownership:
    'target THEIR OWN CALL — which part of this was their decision to make, what they chose it ' +
    'over, and what they owned when it landed; accept that the call may not have been theirs, and ' +
    'if so ask what they would have chosen',
};

const SCENARIO_INSTRUCTION =
  'This topic is a LIVE INCIDENT SIMULATION. Advance the SAME incident based on the ' +
  "candidate's last action: reveal ONE short new fact or symptom that plausibly follows from " +
  'what they just did, then ask what they do next. Never restart or switch incidents, never ' +
  'reveal the root cause yourself.';

/** I-INTEL: anchor instruction template — the concept is code-picked, the phrasing is the LLM's. */
const drillAnchorInstruction = (anchor: string): string =>
  `ANCHOR: the candidate's last answer mentioned "${anchor}". The follow-up MUST probe "${anchor}" ` +
  'exactly as THEY used it, at the drill-focus rung above — like a real interviewer: how it is ' +
  'invalidated/kept correct, where it goes stale or breaks, what they rejected instead, when NOT ' +
  'to use it. Do NOT fall back to a generic topic question.';

const EXAMPLE_DEMAND_INSTRUCTION =
  'The last answer offered nothing concrete to probe. Ask for ONE specific, real example from ' +
  'their own experience on this thread (what they built/broke/measured) — not a definition, not ' +
  'theory. Keep it to a single question.';

/** I-OWN: they described the work but never measured it — make the number part of the question. */
const METRIC_DEMAND_INSTRUCTION =
  'The last answer described the work but put NO measurable outcome on it. The question must ask ' +
  'for the number they actually observed — what they measured it with, before vs after. Ask it as ' +
  'a real interviewer would (curious, not an audit), and accept that they may not have measured it.';

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
        language_instruction: askLanguageInstruction(input.language),
        seniority_target: input.seniorityTarget,
        current_topic: JSON.stringify(input.currentTopic),
        current_thread: input.currentThread,
        recent_qa: JSON.stringify(input.recentQa),
        running_notes: JSON.stringify(input.runningNotes),
        prev_topic_outcome: input.prevTopicOutcome,
        drill_focus: input.ladderRung ? DRILL_FOCUS[input.ladderRung] : '',
        scenario_instruction: input.topicPhase === 'SCENARIO' ? SCENARIO_INSTRUCTION : '',
        drill_anchor_instruction: input.drillAnchor
          ? drillAnchorInstruction(input.drillAnchor)
          : '',
        example_demand_instruction: input.demandExample ? EXAMPLE_DEMAND_INSTRUCTION : '',
        metric_demand_instruction: input.demandMetric ? METRIC_DEMAND_INSTRUCTION : '',
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
      const output = coerceAskOutput(aiRequestId, llmResult.parsedJson, input.language);

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

function coerceAskOutput(
  aiRequestId: string,
  parsed: unknown,
  language: 'vi' | 'en',
): InterviewAskOutput {
  const raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const output = {
    aiRequestId,
    aiMessage: stringValue(raw.ai_message),
    question: stringValue(raw.question),
  };
  return sanitizeAskOutput(output, language);
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

function askLanguageInstruction(language: 'vi' | 'en'): string {
  return language === 'vi'
    ? 'Write both JSON fields in Vietnamese. Preserve English technical terms such as React, useState, REST API, database, Postgres, Node.js, TypeScript, and cache exactly as written.'
    : 'Write both JSON fields in English.';
}

function sanitizeAskOutput(output: InterviewAskOutput, language: 'vi' | 'en'): InterviewAskOutput {
  const question = sanitizeAskQuestion(output.question, language);
  const aiMessage = sanitizeAiMessage(output.aiMessage, question, language);
  return { ...output, aiMessage, question };
}

function sanitizeAiMessage(value: string, question: string, language: 'vi' | 'en'): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  if (normalized.length > MAX_AI_MESSAGE_CHARS) return '';
  if (tokens(normalized).length > MAX_AI_MESSAGE_TOKENS) return '';
  if (QUESTION_LIKE_MESSAGE_PATTERN.test(removeVietnameseMarks(normalized))) return '';
  if (language === 'vi' && isMostlyEnglishForVietnamese(normalized)) return '';
  if (question && compareText(normalized) === compareText(question)) return '';
  return normalized;
}

function sanitizeAskQuestion(value: string, language: 'vi' | 'en'): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  if (language === 'vi' && isMostlyEnglishForVietnamese(normalized)) return '';
  return normalized;
}

function isMostlyEnglishForVietnamese(value: string): boolean {
  if (VIETNAMESE_SCRIPT_PATTERN.test(value)) return false;
  const plain = removeVietnameseMarks(value);
  if (VIETNAMESE_MARKER_PATTERN.test(plain)) return false;

  const textTokens = tokens(plain).filter((token) => !TECHNICAL_TOKENS.has(token));
  if (textTokens.length === 0) return false;
  if (ENGLISH_QUESTION_START_PATTERN.test(textTokens.join(' '))) return true;

  const englishHits = textTokens.filter((token) => ENGLISH_COMMON_TOKENS.has(token)).length;
  const vietnameseHits = textTokens.filter((token) => VIETNAMESE_COMMON_TOKENS.has(token)).length;
  return englishHits >= 4 && englishHits > vietnameseHits * 2;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokens(value: string): string[] {
  return removeVietnameseMarks(value).match(/[\p{L}\p{N}+#.]+/gu) ?? [];
}

function removeVietnameseMarks(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

function compareText(value: string): string {
  return removeVietnameseMarks(value)
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim();
}
