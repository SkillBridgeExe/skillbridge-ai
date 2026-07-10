import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Title-only rename for any owned CV (UPLOADED or BUILT). Trims first, then rejects
 * empty-after-trim via MinLength(1) — the builder autosave must NOT own the title.
 */
export class RenameCvDto {
  @ApiProperty({
    maxLength: 160,
    example: 'Frontend Developer CV',
    description: 'New display title. Trimmed; must be non-empty.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  @MaxLength(160)
  title!: string;
}

/** Slim rename response per the P2 contract — no canonical doc, no skills. */
export interface RenameCvResponseDto {
  id: string;
  title: string | null;
  updatedAt: string | null;
}
