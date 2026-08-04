import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { BillingCreditPackageEntity } from '../../database/entities/billing-credit-package.entity';
import {
  PaymentOrderEntity,
  PaymentOrderStatus,
} from '../../database/entities/payment-order.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { EntitlementsService } from './entitlements.service';
import {
  BillingPlanDto,
  CreditBalanceDto,
  CreditPackageDto,
  CreateCheckoutDto,
  OrderStatusResponseDto,
  SubscriptionResponseDto,
} from './dto/billing.dto';
import { BillingPlanCode } from '../../common/constants/billing.constants';
import { PaymentProviderRegistry } from './payment-providers/payment-provider.registry';
import { BillingCheckoutService } from './services/billing-checkout.service';
import { BillingSettlementService } from './services/billing-settlement.service';
import { PaymentWebhookService } from './services/payment-webhook.service';
import { VoucherService } from './voucher.service';
import { CreditBalanceService } from './credit-balance.service';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    @InjectRepository(BillingCreditPackageEntity)
    private readonly creditPackages: Repository<BillingCreditPackageEntity>,
    @InjectRepository(PlanFeatureEntity) private readonly features: Repository<PlanFeatureEntity>,
    @InjectRepository(PaymentOrderEntity) private readonly orders: Repository<PaymentOrderEntity>,
    private readonly entitlements: EntitlementsService,
    private readonly checkout: BillingCheckoutService,
    private readonly webhooks: PaymentWebhookService,
    private readonly providers: PaymentProviderRegistry,
    private readonly settlement: BillingSettlementService,
    private readonly vouchers: VoucherService,
    private readonly credits: CreditBalanceService,
  ) {}

  async listPlans(): Promise<BillingPlanDto[]> {
    const [plans, features] = await Promise.all([
      this.plans.find({
        where: { isActive: true, category: 'SUBSCRIPTION' },
        order: { sortOrder: 'ASC', priceVnd: 'ASC' },
      }),
      this.features.find(),
    ]);
    const featuresByPlan = new Map<string, PlanFeatureEntity[]>();
    for (const feature of features) {
      const current = featuresByPlan.get(feature.planCode) ?? [];
      current.push(feature);
      featuresByPlan.set(feature.planCode, current);
    }
    return plans
      .filter(
        (plan) =>
          plan.category === 'SUBSCRIPTION' &&
          !isInternalPlan(plan) &&
          (plan.code === BillingPlanCode.FREE || plan.code === BillingPlanCode.PREMIUM),
      )
      .map((plan) => ({
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

  createCheckout(userId: string, dto: CreateCheckoutDto, checkoutOrigin?: string) {
    return this.checkout.createCheckout(userId, dto, checkoutOrigin);
  }

  async listCreditPackages(): Promise<CreditPackageDto[]> {
    const rows = await this.creditPackages
      .createQueryBuilder('creditPackage')
      .innerJoinAndSelect('creditPackage.plan', 'plan')
      .where('plan.is_active = true')
      .orderBy('plan.sort_order', 'ASC')
      .getMany();
    return rows.map((row) => ({
      code: row.plan.code,
      name: row.plan.name,
      description: row.plan.description,
      priceVnd: row.plan.priceVnd,
      currency: row.plan.currency,
      creditType: row.creditType,
      units: row.units,
    }));
  }

  getCredits(userId: string): Promise<CreditBalanceDto[]> {
    return this.credits.list(userId);
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

  async reconcileOrder(userId: string, orderCode: number): Promise<OrderStatusResponseDto> {
    const order = await this.findOrderForUser(userId, orderCode);
    if (order.status !== 'PENDING') {
      return this.toOrderResponse(order);
    }
    const claimed = await this.claimProviderCheck(order.id);
    if (!claimed) {
      return this.toOrderResponse(await this.findOrderForUser(userId, orderCode));
    }
    const provider = this.providers.get(order.provider);
    let snapshot;
    try {
      snapshot = await provider.getPaymentStatus({ orderCode: Number(order.orderCode) });
    } catch (error) {
      this.logger.warn({
        event: 'payment_reconcile_failed',
        orderId: order.id,
        orderCode: order.orderCode,
        provider: order.provider,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
    if (snapshot.status === 'PAID') {
      await this.settlement.settlePaidPayment(snapshot);
    } else if (isTerminalNonPaidStatus(snapshot.status)) {
      order.status = snapshot.status;
      order.paymentLinkId = order.paymentLinkId ?? snapshot.paymentLinkId;
      await this.orders.save(order);
      await this.vouchers.releaseByOrder(order.id);
    }
    const refreshed = await this.findOrderForUser(userId, orderCode);
    return this.toOrderResponse(refreshed);
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

  private async findOrderForUser(userId: string, orderCode: number): Promise<PaymentOrderEntity> {
    const order = await this.orders.findOne({ where: { userId, orderCode: String(orderCode) } });
    if (!order) {
      throw new NotFoundException({
        errorCode: ERROR_CODES.PAYMENT_ORDER_NOT_FOUND,
        message: 'Payment order not found',
      });
    }
    return order;
  }

  private async claimProviderCheck(orderId: string): Promise<boolean> {
    const cooldownBoundary = new Date(Date.now() - 10_000);
    const result = await this.orders
      .createQueryBuilder()
      .update(PaymentOrderEntity)
      .set({ lastProviderCheckAt: () => 'CURRENT_TIMESTAMP' })
      .where('id = :orderId', { orderId })
      .andWhere('status = :status', { status: 'PENDING' })
      .andWhere('(last_provider_check_at IS NULL OR last_provider_check_at <= :cooldownBoundary)', {
        cooldownBoundary,
      })
      .execute();
    return (result.affected ?? 0) === 1;
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
      returnUrl: order.returnUrl ?? null,
      paymentLinkId: order.paymentLinkId,
      targetType: order.targetType,
      targetId: order.targetId,
      paidAt: order.paidAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      pricing: {
        originalAmountVnd: order.originalAmountVnd ?? order.amountVnd,
        discountPercent: order.discountPercent ?? 0,
        discountAmountVnd: order.discountAmountVnd ?? 0,
        finalAmountVnd: order.amountVnd,
        voucherCode: order.voucherCode ?? null,
        currency: order.currency,
      },
      creditPackage:
        order.creditType && order.creditUnits
          ? { creditType: order.creditType, units: order.creditUnits }
          : null,
    };
  }
}

function isTerminalNonPaidStatus(
  status: string,
): status is Exclude<PaymentOrderStatus, 'PENDING' | 'PAID'> {
  return status === 'CANCELLED' || status === 'EXPIRED' || status === 'FAILED';
}

function isInternalPlan(plan: BillingPlanEntity): boolean {
  const metadata = plan.metadata;
  return Boolean(
    metadata && typeof metadata === 'object' && 'internal' in metadata && metadata.internal,
  );
}
