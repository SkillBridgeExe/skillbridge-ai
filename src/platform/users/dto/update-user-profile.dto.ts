import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

function isPresent(_object: unknown, value: unknown): boolean {
  return value !== null && value !== undefined;
}

export class UpdateUserProfileDto {
  @ApiPropertyOptional({ example: 'Nguyen Van A', nullable: true })
  @ValidateIf(isPresent)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string | null;

  @ApiPropertyOptional({ example: 'FPT University', nullable: true })
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(160)
  university?: string | null;

  @ApiPropertyOptional({ example: 'Software Engineering', nullable: true })
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(160)
  major?: string | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  experienceYears?: number | null;

  @ApiPropertyOptional({ example: 'Frontend Developer', nullable: true })
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(120)
  targetJob?: string | null;

  @ApiPropertyOptional({ example: 'Become a frontend engineer in a product team.', nullable: true })
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(2000)
  careerGoal?: string | null;

  @ApiPropertyOptional({ example: 'https://github.com/skillbridge', nullable: true })
  @ValidateIf(isPresent)
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  githubUrl?: string | null;

  @ApiPropertyOptional({ example: 'https://www.linkedin.com/in/skillbridge', nullable: true })
  @ValidateIf(isPresent)
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  linkedinUrl?: string | null;

  @ApiPropertyOptional({ example: 'https://portfolio.example.com', nullable: true })
  @ValidateIf(isPresent)
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  portfolioUrl?: string | null;
}
