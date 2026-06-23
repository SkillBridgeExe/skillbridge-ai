import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
}

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
  @ArrayMinSize(1)
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
