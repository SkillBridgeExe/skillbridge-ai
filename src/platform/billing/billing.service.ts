import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { EntitlementsService } from './entitlements.service';
import {
  BillingPlanDto,
  CreateCheckoutDto,
  OrderStatusResponseDto,
  SubscriptionResponseDto,
} from './dto/billing.dto';
import { BillingCheckoutService } from './services/billing-checkout.service';
import { PaymentWebhookService } from './services/payment-webhook.service';

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    @InjectRepository(PlanFeatureEntity) private readonly features: Repository<PlanFeatureEntity>,
    @InjectRepository(PaymentOrderEntity) private readonly orders: Repository<PaymentOrderEntity>,
    private readonly entitlements: EntitlementsService,
    private readonly checkout: BillingCheckoutService,
    private readonly webhooks: PaymentWebhookService,
  ) {}

  async listPlans(): Promise<BillingPlanDto[]> {
    const [plans, features] = await Promise.all([
      this.plans.find({ where: { isActive: true }, order: { sortOrder: 'ASC', priceVnd: 'ASC' } }),
      this.features.find(),
    ]);
    const featuresByPlan = new Map<string, PlanFeatureEntity[]>();
    for (const feature of features) {
      const current = featuresByPlan.get(feature.planCode) ?? [];
      current.push(feature);
      featuresByPlan.set(feature.planCode, current);
    }
    return plans.map((plan) => ({
      code: plan.code,
      name: plan.name,
      description: plan.description,
      category: plan.category,
      interval: plan.interval,
      priceVnd: plan.priceVnd,
      currency: plan.currency,
      features: (featuresByPlan.get(plan.code) ?? []).map((feature) => ({
        featureKey: feature.featureKey,
        limit: feature.limitValue,
        period: feature.period,
      })),
    }));
  }

  createCheckout(userId: string, dto: CreateCheckoutDto) {
    return this.checkout.createCheckout(userId, dto);
  }

  async getOrder(userId: string, orderCode: number): Promise<OrderStatusResponseDto> {
    const order = await this.orders.findOne({ where: { userId, orderCode: String(orderCode) } });
    if (!order) {
      throw new NotFoundException({
        errorCode: ERROR_CODES.PAYMENT_ORDER_NOT_FOUND,
        message: 'Payment order not found',
      });
    }
    return this.toOrderResponse(order);
  }

  async getSubscription(userId: string): Promise<SubscriptionResponseDto> {
    return this.entitlements.getCurrentEntitlements(userId);
  }

  async getUsage(userId: string): Promise<SubscriptionResponseDto> {
    return this.entitlements.listUsage(userId);
  }

  async handlePayosWebhook(body: unknown): Promise<{ ok: true; processed: boolean }> {
    return this.webhooks.handleWebhook('PAYOS', body);
  }

  async handlePaymentProviderWebhook(
    provider: string,
    body: unknown,
  ): Promise<{ ok: true; processed: boolean }> {
    return this.webhooks.handleWebhook(provider, body);
  }

  private toOrderResponse(order: PaymentOrderEntity): OrderStatusResponseDto {
    return {
      orderId: order.id,
      orderCode: Number(order.orderCode),
      purpose: order.purpose,
      status: order.status,
      amountVnd: order.amountVnd,
      currency: order.currency,
      checkoutUrl: order.checkoutUrl,
      paymentLinkId: order.paymentLinkId,
      targetType: order.targetType,
      targetId: order.targetId,
      paidAt: order.paidAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    };
  }
}
