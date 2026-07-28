import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BUSINESS_JOB_ROLE_CODES } from '../../../platform/business-jobs/job-domain';

export const JOB_RECOMMENDATION_SORTS = [
  'RECOMMENDED',
  'SKILL_MATCH',
  'NEWEST',
  'SALARY_DESC',
] as const;
export type JobRecommendationSort = (typeof JOB_RECOMMENDATION_SORTS)[number];

export const JOB_RECOMMENDATION_FIT_VERDICTS = [
  'safe_apply',
  'stretch',
  'not_recommended',
] as const;
export type JobRecommendationFitVerdict = (typeof JOB_RECOMMENDATION_FIT_VERDICTS)[number];

const WORK_MODES = ['ONSITE', 'HYBRID', 'REMOTE'] as const;
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT', 'FREELANCE'] as const;
const EXPERIENCE_LEVELS = ['INTERN', 'FRESHER', 'JUNIOR', 'MIDDLE', 'SENIOR', 'LEAD'] as const;

/**
 * Recommendation browsing contract. `role` is intentionally tri-state:
 * - omitted: use the owned CV's target_role;
 * - a canonical role code: explicit user override;
 * - "all": explicit cross-role exploration.
 */
export class JobRecommendationQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalNumber(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 5;

  @IsOptional()
  @Transform(({ value }) => optionalNumber(value))
  @IsInt()
  @Min(0)
  offset = 0;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn(['all', ...BUSINESS_JOB_ROLE_CODES])
  role?: string;

  @IsOptional()
  @Transform(({ value }) => arrayValue(value, true))
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  cityCodes?: string[];

  @IsOptional()
  @Transform(({ value }) => arrayValue(value, true))
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(WORK_MODES, { each: true })
  workModes?: string[];

  @IsOptional()
  @Transform(({ value }) => arrayValue(value, true))
  @IsArray()
  @ArrayMaxSize(5)
  @IsIn(EMPLOYMENT_TYPES, { each: true })
  employmentTypes?: string[];

  @IsOptional()
  @Transform(({ value }) => arrayValue(value, true))
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(EXPERIENCE_LEVELS, { each: true })
  experienceLevels?: string[];

  @IsOptional()
  @Transform(({ value }) => arrayValue(value, false))
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(JOB_RECOMMENDATION_FIT_VERDICTS, { each: true })
  fit?: JobRecommendationFitVerdict[];

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn(JOB_RECOMMENDATION_SORTS)
  sort: JobRecommendationSort = 'RECOMMENDED';

  @IsOptional()
  @Transform(({ value }) => booleanValue(value))
  @IsBoolean()
  salaryOnly = false;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return Number(value);
}

function arrayValue(value: unknown, uppercase: boolean): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const items = Array.isArray(value) ? value : String(value).split(',');
  const normalized = items
    .map((item) => String(item).trim())
    .filter(Boolean)
    .map((item) => (uppercase ? item.toUpperCase() : item));
  return [...new Set(normalized)];
}

function booleanValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return value;
}
