import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MentorProfileStatus } from '../../../database/entities/mentor-profile.entity';

export const MENTOR_PROFILE_STATUSES: MentorProfileStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
];

export const PUBLIC_MENTOR_SORTS = ['rating_desc', 'price_asc', 'price_desc', 'newest'] as const;
export type PublicMentorSort = (typeof PUBLIC_MENTOR_SORTS)[number];

export const MENTOR_SESSION_DURATIONS = [30, 45, 60, 90, 120] as const;

function isPresent(_object: unknown, value: unknown): boolean {
  return value !== null && value !== undefined;
}

function toNumber(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  return Number(value);
}

export class ListMentorsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  query?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  domain?: string;

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsInt()
  @Min(1)
  @Max(5)
  minRating?: number;

  @IsOptional()
  @IsIn(PUBLIC_MENTOR_SORTS)
  sort?: PublicMentorSort;

  @IsOptional()
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value ?? 12))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class UpdateMentorProfileDto {
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(160)
  headline?: string | null;

  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(120)
  company?: string | null;

  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(280)
  shortBio?: string | null;

  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(3000)
  bio?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  domainTags?: string[];

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsInt()
  @Min(50000)
  @Max(10000000)
  sessionPriceVnd?: number;

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsInt()
  @IsIn(MENTOR_SESSION_DURATIONS)
  sessionDurationMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isAcceptingBookings?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  skillIds?: string[];
}

export class AdminListMentorsQueryDto {
  @IsOptional()
  @IsIn(MENTOR_PROFILE_STATUSES)
  status?: MentorProfileStatus;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  query?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value ?? 20))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class UpdateAdminMentorStatusDto {
  @IsIn(['APPROVED', 'REJECTED', 'SUSPENDED'])
  status!: Extract<MentorProfileStatus, 'APPROVED' | 'REJECTED' | 'SUSPENDED'>;

  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(1000)
  rejectionReason?: string | null;
}

export interface MentorSkillDto {
  id: string;
  displayName: string;
  category: string | null;
}

export interface MentorCardDto {
  id: string;
  slug: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string | null;
  company: string | null;
  shortBio: string | null;
  domains: string[];
  skills: MentorSkillDto[];
  ratingAverage: number | null;
  reviewCount: number;
  completedSessions: number;
  sessionPriceVnd: number;
  sessionDurationMinutes: number;
  currency: 'VND';
  isAcceptingBookings: boolean;
  verified: boolean;
}

export interface MentorProfileDto extends MentorCardDto {
  bio: string | null;
  status: MentorProfileStatus;
  rejectionReason: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface MentorSummaryDto {
  verifiedExperts: number;
  sessionsCompleted: number;
  averageRating: number | null;
  spotlightMentor: MentorCardDto | null;
}

export interface MentorFiltersDto {
  domains: Array<{ value: string; label: string; mentorCount: number }>;
}

export interface MentorListDto {
  items: MentorCardDto[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminMentorListDto {
  items: MentorProfileDto[];
  total: number;
  page: number;
  limit: number;
}
