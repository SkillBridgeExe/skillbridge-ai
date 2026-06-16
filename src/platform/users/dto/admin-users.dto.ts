import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { RoleCode } from '../../../database/entities/role.entity';

export type AdminUserStatusFilter = 'ACTIVE' | 'UNVERIFIED' | 'SUSPENDED';
export type AdminUserMutableStatus = 'ACTIVE' | 'SUSPENDED';

export const ADMIN_USER_ROLE_CODES: RoleCode[] = ['USER', 'MENTOR', 'BUSINESS', 'ADMIN'];
export const ADMIN_USER_STATUS_FILTERS: AdminUserStatusFilter[] = [
  'ACTIVE',
  'UNVERIFIED',
  'SUSPENDED',
];
export const ADMIN_USER_MUTABLE_STATUSES: AdminUserMutableStatus[] = ['ACTIVE', 'SUSPENDED'];
export const ADMIN_USER_SUMMARY_RANGES = [7, 30, 90, 365] as const;

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return Number(value);
}

export class AdminListUsersQueryDto {
  @IsOptional()
  @Transform(({ value }) => toOptionalNumber(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => toOptionalNumber(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(ADMIN_USER_ROLE_CODES)
  role?: RoleCode;

  @IsOptional()
  @IsIn(ADMIN_USER_STATUS_FILTERS)
  status?: AdminUserStatusFilter;

  @IsOptional()
  @IsString()
  createdFrom?: string;

  @IsOptional()
  @IsString()
  createdTo?: string;
}

export class AdminUserSummaryQueryDto {
  @IsOptional()
  @Transform(({ value }) => toOptionalNumber(value))
  @IsInt()
  @IsIn(ADMIN_USER_SUMMARY_RANGES)
  rangeDays = 30;
}

export class UpdateAdminUserStatusDto {
  @IsIn(ADMIN_USER_MUTABLE_STATUSES)
  status!: AdminUserMutableStatus;
}

export class ReplaceAdminUserRolesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(ADMIN_USER_ROLE_CODES, { each: true })
  roles!: RoleCode[];
}
