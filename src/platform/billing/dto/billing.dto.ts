import { IsIn, IsOptional, IsString } from 'class-validator';
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
  qrCode: string | null;
  paymentLinkId: string | null;
  expiresAt: string | null;
}

export interface OrderStatusResponseDto {
  orderId: string;
  orderCode: number;
  purpose: string;
  status: string;
  amountVnd: number;
  currency: string;
  checkoutUrl: string | null;
  paymentLinkId: string | null;
  targetType: string;
  targetId: string | null;
  paidAt: string | null;
  createdAt: string;
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
