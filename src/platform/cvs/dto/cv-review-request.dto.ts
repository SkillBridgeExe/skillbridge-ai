import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class PlatformCvReviewRequestDto {
  @ApiProperty({
    description: 'ID of an already-uploaded CV to re-run diagnosis for.',
    example: '00000000-0000-0000-0000-000000000101',
    format: 'uuid',
  })
  @IsUUID()
  cvId!: string;

  @ApiPropertyOptional({
    description:
      'Optional NEW target role to re-grade against. Omitted = keep the CV stored role. ' +
      'A role with no prior analysis re-grades (skills_relevance is role-specific).',
    example: 'data_analyst',
    maxLength: 80,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  targetRole?: string;

  /**
   * Optional UI locale ('vi' | 'en') for the FEEDBACK language. When set, the review's prose
   * (rationale, tips, top_summary) is produced in this language so it matches the app's UI toggle;
   * CV quotes stay in the CV's own language. Omitted = the detected CV language (backward-compatible).
   * A different `lang` than a cached review's re-generates instead of reusing the previous language.
   */
  @ApiPropertyOptional({
    description: 'UI locale for feedback language (vi|en). Defaults to the detected CV language.',
    enum: ['vi', 'en'],
  })
  @IsOptional()
  @IsIn(['vi', 'en'])
  lang?: 'vi' | 'en';
}
