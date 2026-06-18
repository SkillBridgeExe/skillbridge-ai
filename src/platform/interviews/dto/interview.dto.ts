import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
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
import { InterviewPhase } from '../../../modules/interview/dto/start-interview.dto';

const INTERVIEW_MODES: InterviewMode[] = ['TEXT', 'VOICE', 'HYBRID'];
const INTERVIEW_TYPES: InterviewType[] = ['HR', 'TECHNICAL', 'MIXED'];
const LANGUAGES = ['vi', 'en'] as const;
const MODALITIES = ['TEXT', 'AUDIO'] as const;

function toRoundedNumber(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return numeric;
  return Math.round(numeric * 100) / 100;
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

  @ApiPropertyOptional({ enum: INTERVIEW_MODES, default: 'HYBRID' })
  @IsOptional()
  @IsIn(INTERVIEW_MODES)
  mode?: InterviewMode;

  @ApiPropertyOptional({ enum: INTERVIEW_TYPES, default: 'TECHNICAL' })
  @IsOptional()
  @IsIn(INTERVIEW_TYPES)
  interviewType?: InterviewType;

  @ApiPropertyOptional({ enum: INTERVIEW_VOICES, default: DEFAULT_INTERVIEW_VOICE })
  @IsOptional()
  @IsIn(INTERVIEW_VOICES)
  voice?: InterviewVoice = DEFAULT_INTERVIEW_VOICE;

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

export class AnswerPlatformInterviewDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;

  @ApiProperty({ example: 'Em dùng React Query để cache server state...' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  userAnswer!: string;

  @ApiPropertyOptional({
    description: 'Transcript from voice mode. Omit for text answers.',
  })
  @IsOptional()
  @IsString()
  userTranscript?: string;

  @ApiPropertyOptional({ enum: MODALITIES, default: 'TEXT' })
  @IsOptional()
  @IsIn(MODALITIES)
  modality?: 'TEXT' | 'AUDIO';

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;
}

export class LiveInterviewTurnDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  turnOrder!: number;

  @ApiProperty({ example: 'Bạn đã thiết kế API đó như thế nào?' })
  @IsString()
  @MaxLength(4000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  interviewerQuestion!: string;

  @ApiPropertyOptional({ example: 'Em tách controller, service và repository.' })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  userAnswerText?: string;

  @ApiPropertyOptional({ example: 'Em tách controller, service và repository.' })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  userAnswerTranscript?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;
}

export class EndPlatformInterviewDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;

  @ApiPropertyOptional({
    type: () => [LiveInterviewTurnDto],
    description: 'Reviewed live realtime interview turns to persist before scoring.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LiveInterviewTurnDto)
  liveTurns?: LiveInterviewTurnDto[];
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
  phase: InterviewPhase | null;
  modality: 'TEXT' | 'AUDIO';
  aiRequestId: string | null;
  interviewerMessage: string | null;
  interviewerQuestion: string;
  userAnswerText: string | null;
  userAnswerTranscript: string | null;
  perQuestionScore: number | null;
  strengths: unknown;
  improvements: unknown;
  askedAt: string;
  answeredAt: string | null;
  durationSeconds: number | null;
}

export interface InterviewSessionDto {
  id: string;
  cvId: string | null;
  cvMatchId: string | null;
  jobDescriptionId: string | null;
  targetRole: string;
  language: string;
  mode: InterviewMode;
  interviewType: InterviewType;
  voice: InterviewVoice;
  speechSpeed: number;
  status: InterviewStatus;
  totalQuestionsPlanned: number | null;
  maxDurationSeconds: number;
  expiresAt: string | null;
  overallScore: number | null;
  semanticScore: number | null;
  llmScore: number | null;
  communicationScore: number | null;
  aiFeedback: unknown;
  durationSeconds: number | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface StartInterviewResponseDto extends InterviewSessionDto {
  firstMessage: string;
  firstQuestion: string;
  phase: InterviewPhase | null;
  realtime: RealtimeClientSecretDto;
}

export interface AnswerInterviewResponseDto {
  session: InterviewSessionDto;
  answeredTurn: InterviewTurnDto;
  nextTurn: InterviewTurnDto | null;
  aiMessage: string;
  nextQuestion: string | null;
  finished: boolean;
}

export interface InterviewDetailResponseDto extends InterviewSessionDto {
  turns: InterviewTurnDto[];
}
