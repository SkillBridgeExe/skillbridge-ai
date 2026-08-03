import { BadRequestException } from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { RoleCode } from '../ingest/ingest-normalizers';
import {
  EmploymentType,
  ExperienceLevel,
  JobRecommendationOptions,
  JobRecommendationSort,
  WorkMode,
} from '../reco/job-recommendation.service';
import { FitVerdict } from '../../gap-engine/fit-strategy';

const ROLE_CODES: readonly RoleCode[] = [
  'frontend_developer',
  'backend_developer',
  'fullstack_developer',
  'data_analyst',
  'mobile_developer',
  'devops_engineer',
  'qa_tester',
  'ai_ml_engineer',
  'ai_app_engineer',
];
const WORK_MODES: readonly WorkMode[] = ['ONSITE', 'HYBRID', 'REMOTE'];
const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'FULL_TIME',
  'PART_TIME',
  'INTERNSHIP',
  'CONTRACT',
  'FREELANCE',
];
const EXPERIENCE_LEVELS: readonly ExperienceLevel[] = [
  'INTERN',
  'FRESHER',
  'JUNIOR',
  'MIDDLE',
  'SENIOR',
  'LEAD',
];
const FIT_VERDICTS: readonly FitVerdict['verdict'][] = ['safe_apply', 'stretch', 'not_recommended'];
const SORTS: readonly JobRecommendationSort[] = [
  'RECOMMENDED',
  'SKILL_MATCH',
  'NEWEST',
  'SALARY_DESC',
];

export class JobRecommendationQueryDto {
  @IsOptional()
  @IsUUID()
  snapshotToken?: string;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  offset?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  cityCodes?: string;

  @IsOptional()
  @IsString()
  workModes?: string;

  @IsOptional()
  @IsString()
  employmentTypes?: string;

  @IsOptional()
  @IsString()
  experienceLevels?: string;

  @IsOptional()
  @IsString()
  fit?: string;

  @IsOptional()
  @IsString()
  sort?: string;

  @IsOptional()
  @IsString()
  salaryOnly?: string;
}

function parseInteger(value: string | undefined, field: string): number | undefined {
  if (value == null || value === '') return undefined;
  if (!/^\d+$/.test(value)) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

function parseCsv<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
): T[] {
  if (!value) return [];
  const values = [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  const invalid = values.filter((entry) => !allowed.includes(entry as T));
  if (invalid.length > 0) {
    throw new BadRequestException(`${field} contains unsupported value(s): ${invalid.join(', ')}`);
  }
  return values as T[];
}

function parseCityCodes(value: string | undefined): string[] {
  if (!value) return [];
  const values = [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (values.some((entry) => !/^[A-Z0-9_-]{1,64}$/.test(entry))) {
    throw new BadRequestException('cityCodes contains an invalid city code');
  }
  return values;
}

function parseBoolean(value: string | undefined, field: string): boolean {
  if (value == null || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new BadRequestException(`${field} must be true or false`);
}

export function toJobRecommendationOptions(
  query: JobRecommendationQueryDto,
): JobRecommendationOptions {
  const role = query.role?.trim();
  if (role && role !== 'all' && !ROLE_CODES.includes(role as RoleCode)) {
    throw new BadRequestException(`role contains unsupported value: ${role}`);
  }
  const sort = query.sort?.trim() || 'RECOMMENDED';
  if (!SORTS.includes(sort as JobRecommendationSort)) {
    throw new BadRequestException(`sort contains unsupported value: ${sort}`);
  }

  return {
    snapshotToken: query.snapshotToken,
    limit: parseInteger(query.limit, 'limit'),
    offset: parseInteger(query.offset, 'offset'),
    roleCode: role || undefined,
    cityCodes: parseCityCodes(query.cityCodes),
    workModes: parseCsv(query.workModes, WORK_MODES, 'workModes'),
    employmentTypes: parseCsv(query.employmentTypes, EMPLOYMENT_TYPES, 'employmentTypes'),
    experienceLevels: parseCsv(query.experienceLevels, EXPERIENCE_LEVELS, 'experienceLevels'),
    fit: parseCsv(query.fit, FIT_VERDICTS, 'fit'),
    sort: sort as JobRecommendationSort,
    salaryOnly: parseBoolean(query.salaryOnly, 'salaryOnly'),
  };
}
