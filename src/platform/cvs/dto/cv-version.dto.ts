import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CanonicalCvDocument } from '../../../common/types/canonical-cv';

export class CreateCvVersionDto {
  @ApiPropertyOptional({
    maxLength: 120,
    example: 'Before tailoring',
    description: 'Optional label for a manual snapshot.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({
    enum: ['MANUAL', 'AUTO_PRE_IMPORT'],
    description:
      'Snapshot origin. AUTO_PRE_IMPORT marks the automatic backup the client takes before a ' +
      'destructive import-overwrite. AUTO_PRE_RESTORE is server-only and cannot be set here.',
  })
  @IsOptional()
  @IsIn(['MANUAL', 'AUTO_PRE_IMPORT'])
  origin?: 'MANUAL' | 'AUTO_PRE_IMPORT';
}

export class CvVersionListQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  // Covers the full retention cap (20 auto + 50 manual = 70) in one page — no load-more UI.
  @Max(100)
  limit = 20;
}

export interface CvVersionSummaryDto {
  id: string;
  label: string | null;
  origin: string;
  title: string | null;
  createdAt: string;
}

export interface CvVersionDetailDto extends CvVersionSummaryDto {
  snapshot: CanonicalCvDocument;
}
