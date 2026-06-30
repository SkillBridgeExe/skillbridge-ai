import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const LANGUAGES = ['vi', 'en'] as const;
const REASONS = ['ok', 'too_weak', 'ambiguous', 'no_roles'] as const;

export class CareerTargetStoryRequestDto {
  @ApiProperty({
    example: 'Mình làm web bằng React, viết REST API Node.js và SQL.',
    maxLength: 5000,
    description: 'Free narrative of what the user has done (no form, no role needed).',
  })
  @IsString()
  @MaxLength(5000)
  story!: string;

  @ApiPropertyOptional({ enum: LANGUAGES, default: 'vi' })
  @IsOptional()
  @IsIn(LANGUAGES as unknown as string[])
  language?: (typeof LANGUAGES)[number];
}

export class CareerTargetCandidateDto {
  @ApiProperty()
  role_code!: string;
  @ApiProperty()
  display_name!: string;
  @ApiProperty()
  score!: number;
}

export class CareerTargetStoryResponseDto {
  @ApiProperty({ nullable: true, type: String })
  role_code!: string | null;
  @ApiProperty({ nullable: true, type: String })
  display_name!: string | null;
  @ApiProperty()
  confidence!: number;
  @ApiProperty({ type: [String] })
  matched_skills!: string[];
  @ApiProperty({ type: [CareerTargetCandidateDto] })
  candidates!: CareerTargetCandidateDto[];
  @ApiProperty()
  needs_user_input!: boolean;
  @ApiProperty({ enum: REASONS })
  reason!: (typeof REASONS)[number];
}
