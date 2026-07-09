import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
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
  @Max(50)
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
