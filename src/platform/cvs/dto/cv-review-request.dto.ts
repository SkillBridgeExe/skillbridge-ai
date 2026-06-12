import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
}
