import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const SECTIONS = ['summary', 'projects', 'experience', 'skills', 'education'] as const;
const GAPS = ['action', 'tech', 'result', 'role', 'strength', 'evidence'] as const;
const KINDS = ['bullet', 'summary'] as const;
const LANGS = ['vi', 'en'] as const;
const TONES = ['softer'] as const;
const REQUESTED_ACTIONS = [
  'analyze',
  'add_evidence',
  'make_ats_friendly',
  'turn_into_impact',
] as const;
const REWRITE_INTENTS = [
  'improve',
  'shorten',
  'make_ats_friendly',
  'turn_into_impact',
  'add_evidence',
] as const;
const INTAKE_SECTIONS = ['experience'] as const;

/** Turn-1: ask the engine to analyze one CV field and produce structured questions. */
export class AssistantAnalyzeRequestDto {
  @ApiProperty({ example: 'Worked on the project.', maxLength: 2000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  current_value!: string;

  @ApiPropertyOptional({ enum: SECTIONS })
  @IsOptional()
  @IsIn(SECTIONS as unknown as string[])
  section?: (typeof SECTIONS)[number];

  @ApiPropertyOptional({ example: 'projects[0].bullets[0]', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  field_path?: string;

  @ApiPropertyOptional({ enum: LANGS, default: 'en' })
  @IsOptional()
  @IsIn(LANGS as unknown as string[])
  locale?: (typeof LANGS)[number];

  @ApiPropertyOptional({
    enum: REQUESTED_ACTIONS,
    description:
      'Optional action-chip intent. Used to avoid no-op "already strong" replies when the user explicitly asks for evidence/impact.',
  })
  @IsOptional()
  @IsIn(REQUESTED_ACTIONS as unknown as string[])
  requested_action?: (typeof REQUESTED_ACTIONS)[number];

  @ApiPropertyOptional({
    example: 'backend_developer',
    maxLength: 120,
    description: 'The CV target role (informational; verified server-side from the CV record)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  target_role?: string;
}

/**
 * Turn-1.5: role-aware smart questions (LLM-backed). Same request shape as Turn-1 analyze —
 * `target_role` (inherited) is informational only; the endpoint always reads the real
 * `target_role` server-side from the owned CV record, never from this DTO.
 */
export class AssistantSmartQuestionsRequestDto extends AssistantAnalyzeRequestDto {}

/** one Turn-1 answer: a category chip + an optional concrete detail. */
export class AssistantAnswerDto {
  @ApiProperty({ enum: GAPS })
  @IsIn(GAPS as unknown as string[])
  gap!: (typeof GAPS)[number];

  @ApiProperty({ example: 'built', maxLength: 40 })
  @IsString()
  @MaxLength(40)
  option_id!: string;

  @ApiPropertyOptional({ example: 'Node.js', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  detail?: string;
}

/** Turn-2: rewrite one bullet from the user's grounded answers (anti-fabrication enforced server-side). */
export class AssistantRewriteRequestDto {
  @ApiProperty({ example: 'Worked on the project.', maxLength: 2000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  before!: string;

  @ApiProperty({ type: [AssistantAnswerDto], maxItems: 6 })
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AssistantAnswerDto)
  answers!: AssistantAnswerDto[];

  @ApiProperty({ example: 'projects[0].bullets[0]', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  target!: string;

  @ApiPropertyOptional({
    enum: KINDS,
    default: 'bullet',
    description: 'bullet (project/experience) or summary',
  })
  @IsOptional()
  @IsIn(KINDS as unknown as string[])
  kind?: (typeof KINDS)[number];

  @ApiPropertyOptional({ enum: LANGS, default: 'en' })
  @IsOptional()
  @IsIn(LANGS as unknown as string[])
  locale?: (typeof LANGS)[number];

  @ApiPropertyOptional({
    enum: LANGS,
    description: "The CV's language for the rewritten text. Defaults to locale when absent.",
  })
  @IsOptional()
  @IsIn(LANGS as unknown as string[])
  output_lang?: (typeof LANGS)[number];

  @ApiPropertyOptional({
    enum: TONES,
    description: '"Viết lại nhẹ hơn" — softer phrasing, same facts. Omit for default tone.',
  })
  @IsOptional()
  @IsIn(TONES as unknown as string[])
  tone?: (typeof TONES)[number];

  @ApiPropertyOptional({
    enum: REWRITE_INTENTS,
    description:
      'Action-chip rewrite intent. Lets transform-only chips rewrite safely without faking an answer gap.',
  })
  @IsOptional()
  @IsIn(REWRITE_INTENTS as unknown as string[])
  intent?: (typeof REWRITE_INTENTS)[number];
}

/**
 * Narrative intake (Phase 1: experience): turn a user's free-text story about ONE work-experience
 * entry into structured fields. `locale` is the UI language (user-facing messages); `output_lang`
 * is the CV's language (the extracted text). Anti-fabrication is enforced server-side.
 */
export class ExtractRequestDto {
  @ApiProperty({ enum: INTAKE_SECTIONS, default: 'experience' })
  @IsIn(INTAKE_SECTIONS as unknown as string[])
  section!: (typeof INTAKE_SECTIONS)[number];

  @ApiProperty({
    example: 'Tôi làm ở SmartAI Solutions vị trí AI Engineer từ 05/2023 tới nay.',
    maxLength: 4000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  narrative!: string;

  @ApiPropertyOptional({
    enum: LANGS,
    default: 'en',
    description: 'UI language for user-facing text',
  })
  @IsOptional()
  @IsIn(LANGS as unknown as string[])
  locale?: (typeof LANGS)[number];

  @ApiPropertyOptional({
    enum: LANGS,
    description: "The CV's language for the extracted text. Defaults to locale when absent.",
  })
  @IsOptional()
  @IsIn(LANGS as unknown as string[])
  output_lang?: (typeof LANGS)[number];
}
