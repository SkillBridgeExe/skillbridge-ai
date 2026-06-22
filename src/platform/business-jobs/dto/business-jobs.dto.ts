import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BusinessProfileStatus } from '../../../database/entities/business-profile.entity';
import { CompanySize, CompanyType } from '../../../database/entities/company.entity';
import {
  JobLocationSnapshot,
  JobSkillSnapshot,
} from '../../../database/entities/job-post-version.entity';
import { BUSINESS_JOB_ROLE_CODES, JobApplicationStatus } from '../job-domain';

const COMPANY_TYPES: CompanyType[] = ['PRODUCT', 'OUTSOURCING', 'CONSULTING', 'STARTUP', 'OTHER'];
const COMPANY_SIZES: CompanySize[] = [
  '1_10',
  '11_50',
  '51_100',
  '101_300',
  '301_500',
  '501_1000',
  '1000_PLUS',
];
const WORK_MODES = ['ONSITE', 'HYBRID', 'REMOTE'] as const;
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT', 'FREELANCE'] as const;
const EXPERIENCE_LEVELS = ['INTERN', 'FRESHER', 'JUNIOR', 'MIDDLE', 'SENIOR', 'LEAD'] as const;

function optionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null || value === '' ? undefined : Number(value);
}

function arrayValue(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const values = Array.isArray(value) ? value : String(value).split(',');
  return values
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
}

export class UpdateCompanyDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(255) companyName?: string;
  @IsOptional() @IsUrl({ require_tld: false }) website?: string;
  @IsOptional() @IsEmail() workEmail?: string;
  @IsOptional() @IsString() @MaxLength(255) contactName?: string;
  @IsOptional() @IsString() @MaxLength(32) contactPhone?: string;
  @IsOptional() @IsUrl({ require_tld: false }) linkedinUrl?: string;
  @IsOptional() @IsString() @MaxLength(64) industryCode?: string;
  @IsOptional() @IsIn(COMPANY_TYPES) companyType?: CompanyType;
  @IsOptional() @IsIn(COMPANY_SIZES) companySize?: CompanySize;
  @IsOptional() @IsInt() @Min(1800) @Max(new Date().getUTCFullYear()) foundedYear?: number;
  @IsOptional() @IsString() @Length(2, 2) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(64) headquartersCityCode?: string;
  @IsOptional() @IsString() @MaxLength(1000) headquartersAddress?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsOptional() @IsString() @MaxLength(10_000) description?: string;
  @IsOptional() @IsString() @MaxLength(10_000) cultureDescription?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) benefits?: string[];
}

export class VerifyWorkEmailDto {
  @IsString() @MinLength(32) @MaxLength(256) token!: string;
}

export class AdminBusinessStatusDto {
  @IsIn(['VERIFIED', 'REJECTED', 'SUSPENDED'])
  status!: Extract<BusinessProfileStatus, 'VERIFIED' | 'REJECTED' | 'SUSPENDED'>;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

export class JobLocationDto implements JobLocationSnapshot {
  @IsString() @MaxLength(64) cityCode!: string;
  @IsString() @Length(2, 2) countryCode!: string;
  @IsString() @MaxLength(1000) addressLine!: string;
  @IsBoolean() isPrimary!: boolean;
}

export class JobSkillDto implements JobSkillSnapshot {
  @IsUUID() skillId!: string;
  @IsOptional() @IsString() canonicalName = '';
  @IsIn(['REQUIRED', 'NICE_TO_HAVE']) importance!: 'REQUIRED' | 'NICE_TO_HAVE';
  @IsOptional() @IsInt() @Min(1) @Max(5) minLevel!: number | null;
  @IsOptional() @IsIn(['AUTO', 'BUSINESS']) source: 'AUTO' | 'BUSINESS' = 'BUSINESS';
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence!: number | null;
  @IsOptional() @IsString() @MaxLength(255) rawText!: string | null;
}

export class CreateJobDraftDto {
  @IsString() @MinLength(2) @MaxLength(255) title!: string;
  @IsOptional() @IsIn(BUSINESS_JOB_ROLE_CODES) roleCode?: string;
}

export class UpdateJobDraftDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(255) title?: string;
  @IsOptional() @IsIn(BUSINESS_JOB_ROLE_CODES) roleCode?: string;
  @IsOptional() @IsIn(EMPLOYMENT_TYPES) employmentType?: string;
  @IsOptional() @IsIn(EXPERIENCE_LEVELS) experienceLevel?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(99) minYearsExperience?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(99) maxYearsExperience?: number;
  @IsOptional() @IsIn(WORK_MODES) workMode?: 'ONSITE' | 'HYBRID' | 'REMOTE';
  @IsOptional() @IsInt() @Min(1) @Max(1000) openingsCount?: number;
  @IsOptional() @IsNumber() @Min(0) salaryMin?: number;
  @IsOptional() @IsNumber() @Min(0) salaryMax?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsIn(['MONTH', 'YEAR']) salaryPeriod?: 'MONTH' | 'YEAR';
  @IsOptional() @IsBoolean() salaryVisible?: boolean;
  @IsOptional() @IsBoolean() salaryNegotiable?: boolean;
  @IsOptional() @IsString() @MaxLength(32) educationLevel?: string;
  @IsOptional() @IsString() @MaxLength(16) languageCode?: string;
  @IsOptional() @IsDateString() applicationDeadline?: string;
  @IsOptional() @IsString() @MaxLength(10_000) summary?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) responsibilities?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) requirements?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) niceToHave?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) benefits?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) interviewProcess?: string[];
  @IsOptional() @IsString() @MaxLength(2000) workingTime?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => JobLocationDto)
  locations?: JobLocationDto[];
}

export class ReplaceDraftSkillsDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique((skill: JobSkillDto) => skill.skillId)
  @ValidateNested({ each: true })
  @Type(() => JobSkillDto)
  skills!: JobSkillDto[];
}

export class PublishJobDto {
  @IsInt() @Min(1) expectedRevision!: number;
}

export class PaginationDto {
  @IsOptional() @Transform(({ value }) => optionalNumber(value)) @IsInt() @Min(1) page = 1;
  @IsOptional() @Transform(({ value }) => optionalNumber(value)) @IsInt() @Min(1) @Max(100) limit =
    20;
}

export class PublicJobsQueryDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(255) q?: string;
  @IsOptional()
  @Transform(({ value }) => arrayValue(value))
  @IsArray()
  @IsString({ each: true })
  roleCodes?: string[];
  @IsOptional()
  @Transform(({ value }) => arrayValue(value))
  @IsArray()
  @IsString({ each: true })
  cityCodes?: string[];
  @IsOptional()
  @Transform(({ value }) => arrayValue(value))
  @IsArray()
  @IsIn(WORK_MODES, { each: true })
  workModes?: string[];
  @IsOptional()
  @Transform(({ value }) => arrayValue(value))
  @IsArray()
  @IsIn(EMPLOYMENT_TYPES, { each: true })
  employmentTypes?: string[];
  @IsOptional()
  @Transform(({ value }) => arrayValue(value))
  @IsArray()
  @IsIn(EXPERIENCE_LEVELS, { each: true })
  experienceLevels?: string[];
  @IsOptional()
  @Transform(({ value }) => arrayValue(value))
  @IsArray()
  @IsUUID('4', { each: true })
  skillIds?: string[];
  @IsOptional()
  @Transform(({ value }) => optionalNumber(value))
  @IsNumber()
  @Min(0)
  salaryMin?: number;
  @IsOptional() @IsIn(['ALL', 'NATIVE', 'EXTERNAL']) source: 'ALL' | 'NATIVE' | 'EXTERNAL' = 'ALL';
  @IsOptional() @IsString() @MaxLength(320) companySlug?: string;
  @IsOptional() @IsIn(['NEWEST', 'RELEVANCE', 'SALARY_DESC']) sort:
    | 'NEWEST'
    | 'RELEVANCE'
    | 'SALARY_DESC' = 'NEWEST';
}

export class ApplyToJobDto {
  @IsUUID() jobVersionId!: string;
  @IsUUID() cvId!: string;
  @IsOptional() @IsString() @MaxLength(5000) coverNote?: string;
  @IsString() @MinLength(1) @MaxLength(255) candidateName!: string;
  @IsEmail() candidateEmail!: string;
  @IsOptional() @IsString() @MaxLength(32) candidatePhone?: string;
  @Equals(true) consentAccepted!: true;
  @IsString() @MinLength(1) @MaxLength(64) consentVersion!: string;
}

export class ListApplicationsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['SUBMITTED', 'IN_REVIEW', 'SHORTLISTED', 'REJECTED', 'WITHDRAWN'])
  status?: JobApplicationStatus;
  @IsOptional() @IsString() @MaxLength(255) search?: string;
  @IsOptional() @IsIn(['NEWEST', 'OLDEST', 'MATCH_DESC']) sort: 'NEWEST' | 'OLDEST' | 'MATCH_DESC' =
    'NEWEST';
}

export class UpdateApplicationStatusDto {
  @IsIn(['SUBMITTED', 'IN_REVIEW', 'SHORTLISTED', 'REJECTED', 'WITHDRAWN'])
  expectedStatus!: JobApplicationStatus;
  @IsIn(['IN_REVIEW', 'SHORTLISTED', 'REJECTED']) status!: Extract<
    JobApplicationStatus,
    'IN_REVIEW' | 'SHORTLISTED' | 'REJECTED'
  >;
  @IsOptional() @IsString() @MaxLength(2000) internalNote?: string;
}

export class ReportJobDto {
  @IsIn(['SCAM', 'MISLEADING', 'DISCRIMINATION', 'EXPIRED', 'OTHER']) reasonCode!: string;
  @IsOptional() @IsString() @MaxLength(5000) details?: string;
}

export class ResolveJobReportDto {
  @IsIn(['DISMISSED', 'ACTIONED']) status!: 'DISMISSED' | 'ACTIONED';
  @IsOptional() @IsString() @MaxLength(5000) resolutionNote?: string;
}

export class AdminJobStatusDto {
  @IsIn(['removed']) status!: 'removed';
  @IsString() @MinLength(1) @MaxLength(2000) reason!: string;
}
