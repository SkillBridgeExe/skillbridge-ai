import { IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

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
  @Max(80)
  hours_per_week?: number;

  @IsOptional()
  @IsString()
  prompt_template_code?: string;

  @IsOptional()
  @IsObject()
  user_profile?: Record<string, unknown>;
}
