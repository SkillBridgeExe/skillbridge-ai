import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
} from '../../../common/constants/billing.constants';
import { PaymentOrderPurpose } from '../../../database/entities/payment-order.entity';

export class CreateCheckoutDto {
  @IsIn(['SUBSCRIPTION'])
  purpose!: Extract<PaymentOrderPurpose, 'SUBSCRIPTION'>;

  @IsOptional()
  @IsString()
  planCode?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,64}$/)
  voucherCode?: string;
}

export class ValidateVoucherDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  planCode!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,64}$/)
  voucherCode!: string;
}

export interface PlanFeatureDto {
  featureKey: BillingFeatureKey;
  limit: number;
  period: BillingFeaturePeriod;
}

export interface BillingPlanDto {
  code: string;
  name: string;
  description: string | null;
  category: string;
  interval: string;
  priceVnd: number;
  currency: string;
  features: PlanFeatureDto[];
}

export interface CheckoutResponseDto {
  orderId: string;
  orderCode: number;
  status: string;
  checkoutUrl: string | null;
  returnUrl: string | null;
  qrCode: string | null;
  paymentLinkId: string | null;
  expiresAt: string | null;
  pricing: CheckoutPricingDto;
}

export interface CheckoutPricingDto {
  originalAmountVnd: number;
  discountPercent: number;
  discountAmountVnd: number;
  finalAmountVnd: number;
  voucherCode: string | null;
  currency: string;
}

export interface OrderStatusResponseDto {
  orderId: string;
  orderCode: number;
  purpose: string;
  status: string;
  amountVnd: number;
  currency: string;
  checkoutUrl: string | null;
  returnUrl: string | null;
  paymentLinkId: string | null;
  targetType: string;
  targetId: string | null;
  paidAt: string | null;
  createdAt: string;
  pricing: CheckoutPricingDto;
}

export interface EntitlementFeatureDto {
  featureKey: BillingFeatureKey;
  limit: number;
  period: BillingFeaturePeriod;
  used: number;
  remaining: number | null;
  unlimited: boolean;
  allowed: boolean;
  resetsAt: string;
}

export interface SubscriptionResponseDto {
  planCode: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  features: EntitlementFeatureDto[];
}
