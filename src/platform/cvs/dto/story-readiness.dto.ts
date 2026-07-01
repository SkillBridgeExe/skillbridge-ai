import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { GapItem } from '../../../modules/gap-engine/gap-item';

const BANDS = ['intern', 'fresher', 'mid'] as const;

export class StoryReadinessRequestDto {
  @ApiProperty({ example: 'frontend_developer', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  role_code!: string;

  @ApiPropertyOptional({ enum: BANDS, default: 'fresher' })
  @IsOptional()
  @IsIn(BANDS as unknown as string[])
  band?: (typeof BANDS)[number];
}

export class StoryReadinessResponseDto {
  @ApiProperty({ example: 68 }) readiness!: number;
  @ApiProperty({ example: 'building' }) band!: string;
  @ApiProperty({
    example: 62,
    description:
      'Capped rubric match score (0-100). NOTE: readiness uses the UNCAPPED raw score internally.',
  })
  overall_score!: number;
  @ApiProperty({ example: 0.5 }) required_coverage!: number;
  @ApiProperty({ example: 4 }) matched_count!: number;
  @ApiProperty({ example: 3 }) missing_count!: number;
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description:
      'Canonical GapItem[] (severity-sorted) from the gap engine — full fixability/evidence/requirement_id, not bare skill names.',
  })
  gap_items!: GapItem[];
  @ApiProperty({ description: 'Where to go next to turn the gap into a learning roadmap.' })
  roadmap_pointer!: { route: string; payload: Record<string, unknown> };
  @ApiProperty({ description: 'false → role_code has no rubric; readiness 0, honest empty gap.' })
  role_has_rubric!: boolean;
}
