/**
 * R1b — rewrite contract (R1b-cv-builder-spec.md §6, §9.1). One field in → one suggestion out.
 * Decorated for the global ValidationPipe (whitelist+forbidNonWhitelisted) — see evaluate DTO note.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { BUILDER_SECTIONS, BuilderSection } from './evaluate-section.dto';

export type RewriteMode = 'harvard' | 'translate' | 'custom';

export class RewriteRequestDto {
  /** The single field text the user is editing (a bullet, summary, etc.). */
  @ApiProperty({
    example: 'built admin dashboard with React',
    maxLength: 5000,
    description: 'Required single field text to rewrite. Send one bullet/paragraph at a time.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  text!: string;

  @ApiProperty({
    enum: ['harvard', 'translate', 'custom'],
    example: 'harvard',
    description:
      'Required rewrite mode. harvard improves CV wording, translate changes language, custom follows instruction.',
  })
  @IsIn(['harvard', 'translate', 'custom'])
  mode!: RewriteMode;

  /** Required for mode='translate' — the language to translate INTO. */
  @ApiPropertyOptional({
    enum: ['vi', 'en'],
    example: 'en',
    description: 'Required only when mode=translate. Target language to translate into.',
  })
  @IsOptional()
  @IsIn(['vi', 'en'])
  target_lang?: 'vi' | 'en';

  /** Required for mode='custom' — the user's free-form instruction. */
  @ApiPropertyOptional({
    example: 'Make it shorter and more impact-focused.',
    maxLength: 500,
    description: 'Required only when mode=custom. User instruction for the rewrite.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instruction?: string;

  /** Optional context — tone only, never a fact source. */
  @ApiPropertyOptional({
    example: 'frontend_developer',
    maxLength: 64,
    description: 'Optional IT role code for tone/context. Never used as a fact source.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  role_code?: string;

  @ApiPropertyOptional({
    enum: BUILDER_SECTIONS,
    example: 'experience',
    description: 'Optional builder section where this text came from.',
  })
  @IsOptional()
  @IsIn(BUILDER_SECTIONS)
  section?: BuilderSection;
}

export class RewriteResponseDto {
  /** The rewritten text — FE shows it as "AI đề xuất" with [Viết lại] / [Sử dụng]. */
  suggestion!: string;
  /** True when a deterministic guard had to fall back to the original (see CvRewriteService). */
  fallback?: boolean;
}
