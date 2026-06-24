import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One pre-computed missing/partial skill, normally produced by /internal/ai/cv-jd-match
 * (SkillDiffService output). Caller passes the same shape here to avoid re-doing
 * extraction + diff. Fields match SkillDiffService.MissingSkill / PartialSkill.
 */
export class RoadmapSkillRequirementDto {
  @IsString()
  skill_canonical_name!: string;

  @IsString()
  display_name!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  required_level!: number;

  /** 0 if missing, 1-5 if partial */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  current_level?: number;

  @IsString()
  importance!: string; // 'REQUIRED' | 'PREFERRED' | 'NICE_TO_HAVE'

  @IsOptional()
  weight?: number;
}

export class RoadmapGenerateRequestDto {
  @IsString()
  target_role!: string;

  @IsInt()
  @Min(1)
  @Max(80)
  hours_per_week!: number;

  @IsString()
  prompt_template_code!: string;

  /**
   * Skills the candidate is MISSING entirely (cv_level = 0).
   * Typically passed from CvJdMatchResponseDto.parsed_response.missing_skills.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoadmapSkillRequirementDto)
  missing_skills!: RoadmapSkillRequirementDto[];

  /**
   * Skills the candidate has but at a lower level than required.
   * From CvJdMatchResponseDto.parsed_response.partial_skills.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoadmapSkillRequirementDto)
  partial_skills?: RoadmapSkillRequirementDto[];

  /**
   * Optional CV text for LLM context (helps personalize steps and advice).
   * NOT used to re-run gap analysis — that's already done.
   */
  @IsOptional()
  @IsString()
  cv_text?: string;

  @IsOptional()
  @IsString()
  jd_text?: string;

  @IsOptional()
  @IsObject()
  user_profile?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['vi', 'en', 'both'])
  language_pref?: 'vi' | 'en' | 'both';
}
