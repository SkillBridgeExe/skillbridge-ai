import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';

/**
 * Title-only rename for any owned CV (UPLOADED or BUILT). Contract: trim, 1..200 chars;
 * empty-after-trim is rejected by the service with errorCode TITLE_REQUIRED (not a generic
 * validation message) — the builder autosave must NOT own the title.
 */
export class RenameCvDto {
  @ApiProperty({
    maxLength: 200,
    example: 'Frontend Developer CV',
    description: 'New display title. Trimmed; must be non-empty (400 TITLE_REQUIRED otherwise).',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  title!: string;
}

/** Slim rename response per the P2 contract — no canonical doc, no skills. */
export interface RenameCvResponseDto {
  id: string;
  title: string | null;
  updatedAt: string | null;
}
