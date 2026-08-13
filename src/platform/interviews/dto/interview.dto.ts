import { Transform } from 'class-transformer';
import {
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
import {
  CandidateIntent,
  InterviewExperienceMode,
  InterviewDirectiveAction,
  RealtimeAnswerSignal,
} from '../interview-turn-policy.service';

const INTERVIEW_MODES: InterviewMode[] = ['TEXT', 'VOICE'];
const INTERVIEW_TYPES: InterviewType[] = ['HR', 'TECHNICAL', 'MIXED'];
const LANGUAGES = ['vi', 'en'] as const;
const MODALITIES = ['TEXT', 'AUDIO'] as const;
const EXPERIENCE_MODES: InterviewExperienceMode[] = ['MOCK', 'PRACTICE'];
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
const ANSWER_SIGNALS: RealtimeAnswerSignal[] = ['COMPLETE', 'PARTIAL', 'OFF_TOPIC', 'NO_ANSWER'];
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

export class RealtimeInterviewTurnDto {
  @ApiProperty({ example: 'turn-client-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  clientTurnId!: string;

  @ApiProperty({ example: 'I would use a cache-aside strategy.' })
  @IsString()
  @MaxLength(8000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  transcript!: string;

  @ApiProperty({ enum: MODALITIES })
  @IsIn(MODALITIES)
  modality!: 'TEXT' | 'AUDIO';

  @ApiProperty({ enum: CANDIDATE_INTENTS })
  @IsIn(CANDIDATE_INTENTS)
  intent!: CandidateIntent;

  @ApiProperty({ enum: ANSWER_SIGNALS })
  @IsIn(ANSWER_SIGNALS)
  answerSignal!: RealtimeAnswerSignal;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  speechEndedAt?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  responseDelayMs?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  transcriptSegments?: number;
}

export class CommitRealtimeAssistantMessageDto {
  @ApiProperty({ example: 'resp_123' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  responseId!: string;

  @ApiPropertyOptional({ example: 'Thanks for walking me through that.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  interviewerMessage?: string;

  @ApiProperty({ example: 'How would you invalidate stale cache entries?' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  interviewerQuestion!: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  firstAudioAt?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  interrupted?: boolean;
}

export interface RealtimeTurnDirectiveDto {
  directiveId: string;
  action: InterviewDirectiveAction;
  topicId: string | null;
  questionThreadId: string;
  difficultyStep: number;
  assistanceLevel: 'NONE' | 'EASIER' | 'HINT' | 'SKIPPED';
  scoreCap: number | null;
  threadScore: number | null;
  consumesAttempt: boolean;
  fallbackQuestion: string;
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
