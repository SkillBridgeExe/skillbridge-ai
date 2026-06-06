/**
 * R1b — rewrite contract (R1b-cv-builder-spec.md §6, §9.1). One field in → one suggestion out.
 * Decorated for the global ValidationPipe (whitelist+forbidNonWhitelisted) — see evaluate DTO note.
 */
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { BUILDER_SECTIONS, BuilderSection } from './evaluate-section.dto';

export type RewriteMode = 'harvard' | 'translate' | 'custom';

export class RewriteRequestDto {
  /** The single field text the user is editing (a bullet, summary, etc.). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  text!: string;

  @IsIn(['harvard', 'translate', 'custom'])
  mode!: RewriteMode;

  /** Required for mode='translate' — the language to translate INTO. */
  @IsOptional()
  @IsIn(['vi', 'en'])
  target_lang?: 'vi' | 'en';

  /** Required for mode='custom' — the user's free-form instruction. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instruction?: string;

  /** Optional context — tone only, never a fact source. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  role_code?: string;

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
