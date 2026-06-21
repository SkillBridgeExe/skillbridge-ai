import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  BillingPlanCategory,
  BillingPlanInterval,
} from '../../../database/entities/billing-plan.entity';
import {
  BILLING_FEATURE_KEYS,
  BILLING_FEATURE_PERIODS,
  BillingFeatureKey,
  BillingFeaturePeriod,
} from '../../../common/constants/billing.constants';
import {
  PaymentOrderPurpose,
  PaymentOrderStatus,
} from '../../../database/entities/payment-order.entity';
import { MentorBookingStatus } from '../../../database/entities/mentor-booking.entity';
import { UserSubscriptionStatus } from '../../../database/entities/user-subscription.entity';

const PLAN_CATEGORIES: BillingPlanCategory[] = ['SUBSCRIPTION', 'MENTOR_PACKAGE'];
const PLAN_INTERVALS: BillingPlanInterval[] = ['MONTHLY', 'ONE_TIME'];
const PAYMENT_STATUSES: PaymentOrderStatus[] = [
  'PENDING',
  'PAID',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
];
const PAYMENT_PURPOSES: PaymentOrderPurpose[] = [
  'SUBSCRIPTION',
  'MENTOR_DEPOSIT',
  'MENTOR_REMAINING',
];
const SUBSCRIPTION_STATUSES: UserSubscriptionStatus[] = [
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
];
const MENTOR_BOOKING_STATUSES: MentorBookingStatus[] = [
  'PENDING_DEPOSIT',
  'AWAITING_REMAINING',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
];

export class AdminBillingPlanFeatureInputDto {
  @IsIn(BILLING_FEATURE_KEYS)
  featureKey!: BillingFeatureKey;

  @IsInt()
  @Min(-1)
  limitValue!: number;

  @IsOptional()
  @IsIn(BILLING_FEATURE_PERIODS)
  period?: BillingFeaturePeriod;
}

export class CreateAdminBillingPlanDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Matches(/^[A-Z0-9_]{2,64}$/)
  code!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn(PLAN_CATEGORIES)
  category!: BillingPlanCategory;

  @IsIn(PLAN_INTERVALS)
  interval!: BillingPlanInterval;

  @IsInt()
  @Min(0)
  priceVnd!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminBillingPlanFeatureInputDto)
  features?: AdminBillingPlanFeatureInputDto[];
}

export class UpdateAdminBillingPlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsIn(PLAN_CATEGORIES)
  category?: BillingPlanCategory;

  @IsOptional()
  @IsIn(PLAN_INTERVALS)
  interval?: BillingPlanInterval;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceVnd?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown> | null;
}

export class ReplaceAdminPlanFeaturesDto {
  @IsArray()
  @ArrayUnique((feature: AdminBillingPlanFeatureInputDto) => feature.featureKey)
  @ValidateNested({ each: true })
  @Type(() => AdminBillingPlanFeatureInputDto)
  features!: AdminBillingPlanFeatureInputDto[];
}

export class AdminListPlansQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

export class AdminPaginationQueryDto {
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

export class AdminListOrdersQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: PaymentOrderStatus;

  @IsOptional()
  @IsIn(PAYMENT_PURPOSES)
  purpose?: PaymentOrderPurpose;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class AdminListSubscriptionsQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: UserSubscriptionStatus;

  @IsOptional()
  @IsString()
  planCode?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class AdminListMentorBookingsQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @IsIn(MENTOR_BOOKING_STATUSES)
  status?: MentorBookingStatus;

  @IsOptional()
  @IsUUID()
  studentId?: string;

  @IsOptional()
  @IsUUID()
  mentorId?: string;
}

export class UpdateAdminMentorBookingRefundDto {
  @IsIn(['PROCESSED', 'REJECTED'])
  status!: 'PROCESSED' | 'REJECTED';

  @IsString()
  @Matches(/\S/)
  note!: string;
}
