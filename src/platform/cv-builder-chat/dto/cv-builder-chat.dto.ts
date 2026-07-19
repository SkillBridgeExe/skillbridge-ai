import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

/** The single CV-builder field the FE is currently editing — an opaque FE-owned field_path echoed
 *  back verbatim (never parsed/minted against CanonicalCvDocument), plus its current text. Facts
 *  (gaps, target_role, section presence) are ALWAYS rebuilt server-side from the owned CV. */
export class CvBuilderFocusedFieldDto {
  @IsString()
  @MaxLength(200)
  field_path!: string;

  @IsString()
  @MaxLength(8000)
  current_value!: string;
}

/**
 * Body for `POST /api/cvs/:cvId/builder/chat`. NO `thread` field on purpose: history is loaded
 * server-side from persisted chat_messages rows (mirrors the diagnosis CV-only route) — a
 * client-sent thread would be a fact-injection vector into the grounding gate.
 */
export class CvBuilderChatRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CvBuilderFocusedFieldDto)
  focused_field?: CvBuilderFocusedFieldDto;

  /** "vi" | "en" (or any short language tag) — answer language. */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;
}
