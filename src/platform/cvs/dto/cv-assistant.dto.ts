import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const SECTIONS = ['summary', 'projects', 'experience', 'skills', 'education'] as const;
const GAPS = ['action', 'tech', 'result'] as const;
const LANGS = ['vi', 'en'] as const;

/** Turn-1: ask the engine to analyze one CV field and produce structured questions. */
export class AssistantAnalyzeRequestDto {
  @ApiProperty({ example: 'Worked on the project.', maxLength: 2000 })
  @IsString()
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
  @MaxLength(2000)
  before!: string;

  @ApiProperty({ type: [AssistantAnswerDto], maxItems: 6 })
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AssistantAnswerDto)
  answers!: AssistantAnswerDto[];

  @ApiProperty({ example: 'projects[0].bullets[0]', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  target!: string;

  @ApiPropertyOptional({ enum: LANGS, default: 'en' })
  @IsOptional()
  @IsIn(LANGS as unknown as string[])
  locale?: (typeof LANGS)[number];
}
