import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DEFAULT_INTERVIEW_SPEECH_SPEED,
  DEFAULT_INTERVIEW_VOICE,
  InterviewMode,
  InterviewStatus,
  InterviewType,
  INTERVIEW_VOICES,
  InterviewVoice,
} from '../../../database/entities/interview-session.entity';
import { InterviewTurnPhase } from '../../../database/entities/interview-turn.entity';
import { InterviewPhase as AgendaInterviewPhase } from '../../../modules/interview/interview-agenda';
import { InterviewExperienceMode } from '../../../database/entities/interview-session.entity';

const INTERVIEW_MODES: InterviewMode[] = ['TEXT', 'VOICE'];
const INTERVIEW_TYPES: InterviewType[] = ['HR', 'TECHNICAL', 'MIXED'];
const LANGUAGES = ['vi', 'en'] as const;
const MODALITIES = ['TEXT', 'AUDIO'] as const;
const EXPERIENCE_MODES: InterviewExperienceMode[] = ['MOCK', 'PRACTICE'];
export type CandidateIntent =
  | 'ANSWER'
  | 'NO_ANSWER'
  | 'REPEAT'
  | 'CLARIFY'
  | 'EASIER'
  | 'HINT'
  | 'FEEDBACK'
  | 'SKIP'
  | 'END';
const CANDIDATE_INTENTS: CandidateIntent[] = [
  'ANSWER',
  'NO_ANSWER',
  'REPEAT',
  'CLARIFY',
  'EASIER',
  'HINT',
  'FEEDBACK',
  'SKIP',
  'END',
];
const REALTIME_KINDS = ['REALTIME_EXCHANGE', 'TEXT_FALLBACK'] as const;
const REALTIME_INPUT_TYPES = ['ANSWER', 'CONTROL', 'CAPTURE_RETRY'] as const;
const INTENT_SOURCES = ['VOICE_LEXICAL', 'BUTTON', 'TEXT'] as const;
export const INTERVIEW_CONTEXT_MODES = ['ROLE_ONLY', 'CV_ONLY', 'CV_JD_MATCH'] as const;
export type InterviewContextMode = (typeof INTERVIEW_CONTEXT_MODES)[number];

function toRoundedNumber(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return numeric;
  return Math.round(numeric * 100) / 100;
}

function toOptionalBoolean(value: unknown): unknown {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

export class StartPlatformInterviewDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cvId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cvMatchId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  jobDescriptionId?: string;

  @ApiProperty({ example: 'frontend_developer' })
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  targetRole!: string;

  @ApiPropertyOptional({ enum: LANGUAGES, default: 'vi' })
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: 'vi' | 'en';

  @ApiPropertyOptional({ enum: INTERVIEW_MODES, default: 'VOICE' })
  @IsOptional()
  @IsIn(INTERVIEW_MODES)
  mode?: InterviewMode;

  @ApiPropertyOptional({ enum: EXPERIENCE_MODES, default: 'MOCK' })
  @IsOptional()
  @IsIn(EXPERIENCE_MODES)
  experienceMode?: InterviewExperienceMode;

  @ApiPropertyOptional({ enum: INTERVIEW_TYPES, default: 'TECHNICAL' })
  @IsOptional()
  @IsIn(INTERVIEW_TYPES)
  interviewType?: InterviewType;

  @ApiPropertyOptional({ enum: INTERVIEW_VOICES, default: DEFAULT_INTERVIEW_VOICE })
  @IsOptional()
  @IsIn(INTERVIEW_VOICES)
  voice?: InterviewVoice;

  @ApiPropertyOptional({
    default: DEFAULT_INTERVIEW_SPEECH_SPEED,
    minimum: 0.75,
    maximum: 1.5,
    description: 'Speech speed for generated interviewer voice.',
  })
  @Transform(({ value }) => toRoundedNumber(value))
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.75)
  @Max(1.5)
  speechSpeed?: number = DEFAULT_INTERVIEW_SPEECH_SPEED;
}

export class RealtimeExchangeInputDto {
  @ApiProperty({ enum: REALTIME_INPUT_TYPES })
  @IsIn(REALTIME_INPUT_TYPES)
  type!: 'ANSWER' | 'CONTROL' | 'CAPTURE_RETRY';

  @ApiProperty({ enum: MODALITIES })
  @IsIn(MODALITIES)
  modality!: 'TEXT' | 'AUDIO';

  @ApiPropertyOptional({ maxLength: 8000 })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  transcript?: string;

  @ApiPropertyOptional({ enum: CANDIDATE_INTENTS })
  @IsOptional()
  @IsIn(CANDIDATE_INTENTS)
  intent?: CandidateIntent;

  @ApiProperty({ enum: INTENT_SOURCES })
  @IsIn(INTENT_SOURCES)
  intentSource!: 'VOICE_LEXICAL' | 'BUTTON' | 'TEXT';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds?: string[];

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  speechStartedAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  speechEndedAt?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  segmentCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  meanLogprob?: number;
}

export class RealtimeExchangeAssistantDto {
  @ApiProperty({ example: 'resp_123' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  responseId!: string;

  @ApiProperty({ maxLength: 8000 })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  transcript!: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  firstAudioAt?: string;

  @ApiProperty({ default: false })
  @IsBoolean()
  interrupted!: boolean;
}

export class RealtimeInterviewTurnDto {
  @ApiProperty({ enum: REALTIME_KINDS })
  @IsIn(REALTIME_KINDS)
  kind!: 'REALTIME_EXCHANGE' | 'TEXT_FALLBACK';

  @ApiProperty({ example: 'turn-client-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  clientTurnId!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  questionTurnId?: string | null;

  @ApiPropertyOptional({ type: RealtimeExchangeInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RealtimeExchangeInputDto)
  input?: RealtimeExchangeInputDto;

  @ApiPropertyOptional({ type: RealtimeExchangeAssistantDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RealtimeExchangeAssistantDto)
  assistant?: RealtimeExchangeAssistantDto;

  @ApiPropertyOptional({ maxLength: 8000 })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  text?: string;

  @ApiPropertyOptional({ enum: CANDIDATE_INTENTS })
  @IsOptional()
  @IsIn(CANDIDATE_INTENTS)
  intent?: CandidateIntent;
}

export type RealtimeExchangeDisposition =
  | 'COMMITTED'
  | 'DUPLICATE'
  | 'CAPTURE_RETRY'
  | 'CONTROL_APPLIED'
  | 'PENDING';

export interface RealtimeExchangeResponseDto {
  clientTurnId: string;
  disposition: RealtimeExchangeDisposition;
  answeredTurnId: string | null;
  currentTurnId: string | null;
  assistant: {
    responseId: string | null;
    transcript: string;
    question: string | null;
  } | null;
  finished: boolean;
}
export class EndPlatformInterviewDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;
}

export class InterviewListQueryDto {
  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    description: 'Page number, starting at 1.',
  })
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    default: 10,
    minimum: 1,
    maximum: 10,
    description: 'Items per page.',
  })
  @Transform(({ value }) => Number(value ?? 10))
  @IsInt()
  @Min(1)
  @Max(10)
  limit: number = 10;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Return only completed sessions that have an overall score.',
  })
  @Transform(({ obj, key }) => toOptionalBoolean((obj as Record<string, unknown>)[key]))
  @IsOptional()
  @IsBoolean()
  scoredOnly?: boolean;
}

export interface RealtimeClientSecretDto {
  enabled: boolean;
  provider: 'openai';
  model: string | null;
  protocolVersion: 'interview-realtime-v3';
  transcriptionModel: string;
  clientSecret: string | null;
  expiresAt: string | null;
  reason?: string;
}

export interface InterviewTurnDto {
  id: string;
  sessionId: string;
  turnOrder: number;
  phase: InterviewTurnPhase | null;
  topicPhase: AgendaInterviewPhase | null;
  modality: 'TEXT' | 'AUDIO';
  aiRequestId: string | null;
  interviewerMessage: string | null;
  interviewerQuestion: string;
  userAnswerText: string | null;
  userAnswerTranscript: string | null;
  perQuestionScore: number | null;
  depthSignal: string | null;
  signals: unknown;
  insight: unknown;
  /** persisted per-turn decision trace (I-CONSIST-2) — additive, null on legacy turns. */
  turnTrace: unknown;
  currentThread: string | null;
  skillCanonical: string | null;
  questionBankItemId: string | null;
  questionBankKey: string | null;
  strengths: unknown;
  improvements: unknown;
  askedAt: string;
  answeredAt: string | null;
  durationSeconds: number | null;
  /** P3 speech timing (voice mode) — null on text/legacy turns. */
  responseDelayMs: number | null;
  transcriptSegments: number | null;
  /**
   * I-PACE: seconds the engine budgeted for answering THIS question. Null on legacy and
   * reviewed-live turns, which were never issued one — a client seeing null shows no pacing UI.
   * Overtime is `answeredAt - askedAt > timeBudgetSeconds`; both timestamps are already here and
   * are server-set, so the report never has to trust the client-reported `durationSeconds`.
   */
  timeBudgetSeconds: number | null;
  questionThreadId: string | null;
  candidateIntent: CandidateIntent | null;
  assistanceLevel: 'NONE' | 'EASIER' | 'HINT' | 'SKIPPED';
  scoreCap: number | null;
  rawScore: number | null;
  finalQuestionScore: number | null;
  skipReason: string | null;
}

export type InterviewAnalysisStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'READY'
  | 'FAILED'
  | 'NOT_REQUIRED';

export interface InterviewSessionDto {
  id: string;
  cvId: string | null;
  cvMatchId: string | null;
  jobDescriptionId: string | null;
  contextMode: InterviewContextMode;
  targetRole: string;
  language: string;
  mode: InterviewMode;
  experienceMode: InterviewExperienceMode;
  interviewType: InterviewType;
  voice: InterviewVoice;
  speechSpeed: number;
  status: InterviewStatus;
  analysisStatus: InterviewAnalysisStatus;
  totalQuestionsPlanned: number | null;
  maxDurationSeconds: number;
  expiresAt: string | null;
  overallScore: number | null;
  semanticScore: number | null;
  llmScore: number | null;
  communicationScore: number | null;
  aiFeedback: unknown;
  finalScore: unknown;
  gapItems: unknown;
  devPlan: unknown;
  coaching: unknown;
  durationSeconds: number | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface StartInterviewResponseDto extends InterviewSessionDto {
  currentTurnId: string;
  firstMessage: string;
  firstQuestion: string;
  phase: InterviewTurnPhase | null;
  realtime: RealtimeClientSecretDto;
  /** I-PACE: seconds budgeted for answering `firstQuestion` (this response carries no turn DTO). */
  answerBudgetSeconds: number | null;
}

export interface InterviewDetailResponseDto extends InterviewSessionDto {
  turns: InterviewTurnDto[];
}
