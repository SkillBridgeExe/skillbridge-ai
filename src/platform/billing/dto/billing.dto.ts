import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaymentOrderPurpose } from '../../../database/entities/payment-order.entity';

export class CreateCheckoutDto {
  @IsIn(['SUBSCRIPTION', 'MENTOR_DEPOSIT', 'MENTOR_REMAINING'])
  purpose!: PaymentOrderPurpose;

  @IsOptional()
  @IsString()
  planCode?: string;

  @IsOptional()
  @IsUUID()
  mentorId?: string;

  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @IsOptional()
  @IsDateString()
  slotStart?: string;

  @IsOptional()
  @IsDateString()
  slotEnd?: string;
}

export interface PlanFeatureDto {
  featureKey: string;
  limit: number;
  period: string;
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
  featureKey: string;
  limit: number;
  used: number;
  remaining: number | null;
  unlimited: boolean;
  allowed: boolean;
}

export interface SubscriptionResponseDto {
  planCode: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  features: EntitlementFeatureDto[];
}
