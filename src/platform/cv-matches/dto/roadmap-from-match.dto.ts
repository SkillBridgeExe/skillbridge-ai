import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Body for POST /api/cv-matches/:matchId/roadmap.
 *
 * Deliberately carries NO missing_skills/partial_skills: the learning gaps are derived
 * server-side from the persisted GapReport (deriveRoadmapGapsFromReport, learn-only), so the
 * client cannot inject arbitrary skills into the roadmap. Only generation knobs are accepted.
 */
export class RoadmapFromMatchDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  available_days?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(80)
  hours_per_week?: number;

  @IsOptional()
  @IsIn(['vi', 'en', 'both'])
  language_pref?: 'vi' | 'en' | 'both';

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  minutes_per_session?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(35)
  sessions_per_week?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  study_days_per_week?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  selected_skill_order?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excluded_skills?: string[];

  @IsOptional()
  @IsObject()
  selected_resources?: Record<string, string[]>;

  @IsOptional()
  @IsBoolean()
  translate_display?: boolean;

  @IsOptional()
  @IsString()
  prompt_template_code?: string;

  @IsOptional()
  @IsObject()
  user_profile?: Record<string, unknown>;
}
