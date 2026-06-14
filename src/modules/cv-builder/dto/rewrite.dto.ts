/**
 * R1b — rewrite contract (R1b-cv-builder-spec.md §6, §9.1). One field in → one suggestion out.
 * Decorated for the global ValidationPipe (whitelist+forbidNonWhitelisted) — see evaluate DTO note.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BUILDER_SECTIONS, BuilderSection } from './evaluate-section.dto';

export type RewriteMode = 'harvard' | 'translate' | 'custom' | 'tailor';

/**
 * @deprecated PR4.5 — the FE no longer dictates the tailor action. The skill/level fields here
 * are NO LONGER trusted as facts (a malicious FE could foreground a skill the candidate lacks).
 * Send `match_id` + `action_id` instead; the server re-derives the action from the gap report and
 * builds the instruction from the VERIFIED action. Kept optional only so an in-flight old-FE
 * request fails with a clear error instead of a whitelist 400 during the transition window.
 */
export class TailorActionInputDto {
  @ApiProperty({ enum: ['emphasize', 'deepen_wording'] })
  @IsIn(['emphasize', 'deepen_wording'])
  action_type!: 'emphasize' | 'deepen_wording';

  /** @deprecated Ignored as a fact source since PR4.5 — verified server-side from the gap report. */
  @ApiProperty({ example: 'React', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  skill_display!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  cv_level?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  required_level?: number;
}

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
    enum: ['harvard', 'translate', 'custom', 'tailor'],
    example: 'harvard',
    description:
      'Required rewrite mode. harvard improves CV wording, translate changes language, custom follows instruction, tailor follows a server-built instruction from a verified gap analysis.',
  })
  @IsIn(['harvard', 'translate', 'custom', 'tailor'])
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

  /**
   * Opaque regenerate token. The first suggestion for a field sends none (cacheable —
   * re-opening the same field is free). An explicit "Viết lại / Tạo lại" click sends a
   * changing value so the cache key differs → a FRESH suggestion at a higher temperature,
   * instead of the byte-identical cached sentence. Mixed into the cache key only; never
   * rendered into the prompt.
   */
  @ApiPropertyOptional({
    example: '1',
    maxLength: 16,
    description: 'Opaque token to force a fresh suggestion on explicit regenerate.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  variant?: string;

  /**
   * Required for mode='tailor' — the CV↔JD match whose gap report the action belongs to. The
   * server reloads this match, verifies ownership (it must belong to the caller AND to the CV in
   * the route), and rebuilds the gap report to verify the action below.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Required for mode=tailor. The CV↔JD match the verified action belongs to.',
  })
  @IsOptional()
  @IsUUID()
  match_id?: string;

  /**
   * Required for mode='tailor' — the stable `action_id` (`${action_type}:${skill_canonical}`) from
   * the gap report's recommended_actions. The server finds this action, asserts it is rewritable,
   * and builds the instruction from it. The FE never sends the skill/level facts anymore.
   */
  @ApiPropertyOptional({
    example: 'deepen_wording:sql',
    maxLength: 128,
    description: 'Required for mode=tailor. Stable action_id from the gap report.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  action_id?: string;

  /**
   * @deprecated PR4.5 — ignored as a fact source; send `match_id` + `action_id` instead. Kept
   * optional only for transitional tolerance (see TailorActionInputDto).
   */
  @ApiPropertyOptional({ type: TailorActionInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TailorActionInputDto)
  tailor_action?: TailorActionInputDto;
}

export class RewriteResponseDto {
  /** The rewritten text — FE shows it as "AI đề xuất" with [Viết lại] / [Sử dụng]. */
  suggestion!: string;
  /** True when a deterministic guard had to fall back to the original (see CvRewriteService). */
  fallback?: boolean;
}
