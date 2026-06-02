import { Transform } from 'class-transformer';
import { Equals, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
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
}
