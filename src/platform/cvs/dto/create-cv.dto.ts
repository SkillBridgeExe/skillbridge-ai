import { Transform } from 'class-transformer';
import { Equals, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCvDto {
  @ApiPropertyOptional({ example: 'Frontend CV 2026' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ example: 'frontend_developer' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  targetRole?: string;

  @ApiProperty({
    example: true,
    description: 'User consent for processing CV personal data.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @Equals(true)
  consentAccepted!: boolean;

  /**
   * Optional UI locale ('vi' | 'en') for the review FEEDBACK language, so the first diagnosis
   * matches the app's UI toggle. Omitted = the detected CV language (backward-compatible).
   */
  @ApiPropertyOptional({
    enum: ['vi', 'en'],
    description: 'UI locale for review feedback language.',
  })
  @IsOptional()
  @IsIn(['vi', 'en'])
  lang?: 'vi' | 'en';
}
