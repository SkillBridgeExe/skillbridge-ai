import { Repository } from 'typeorm';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
  BillingPlanCode,
} from '../../common/constants/billing.constants';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { BillingCreditPackageEntity } from '../../database/entities/billing-credit-package.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { EntitlementsService } from './entitlements.service';
import { PaymentProviderPort } from './payment-providers/payment-provider.port';
import { PaymentProviderRegistry } from './payment-providers/payment-provider.registry';
import { BillingService } from './billing.service';
import { BillingCheckoutService } from './services/billing-checkout.service';
import { BillingSettlementService } from './services/billing-settlement.service';
import { PaymentWebhookService } from './services/payment-webhook.service';
import { VoucherService } from './voucher.service';
import { CreditBalanceService } from './credit-balance.service';

type RepoMock<T extends object> = Pick<
  Repository<T>,
  'createQueryBuilder' | 'find' | 'findOne' | 'save'
> & {
  createQueryBuilder: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
};

function repo<T extends object>(): RepoMock<T> {
  return {
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve(input)),
  } as unknown as RepoMock<T>;
}

describe('BillingService reconcileOrder', () => {
  function setup() {
    const plans = repo<BillingPlanEntity>();
    const creditPackages = repo<BillingCreditPackageEntity>();
    const features = repo<PlanFeatureEntity>();
    const orders = repo<PaymentOrderEntity>();
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    orders.createQueryBuilder.mockReturnValue(queryBuilder);
    const entitlements = {
      getCurrentEntitlements: jest.fn(),
      listUsage: jest.fn(),
    } as unknown as EntitlementsService;
    const checkout = { createCheckout: jest.fn() } as unknown as BillingCheckoutService;
    const webhooks = { handleWebhook: jest.fn() } as unknown as PaymentWebhookService;
    const provider = {
      code: 'PAYOS',
      createPaymentLink: jest.fn(),
      verifyWebhook: jest.fn(),
      getPaymentStatus: jest.fn(),
    } as unknown as jest.Mocked<PaymentProviderPort>;
    const providers = {
      get: jest.fn().mockReturnValue(provider),
    } as unknown as PaymentProviderRegistry;
    const settlement = {
      settlePaidPayment: jest.fn().mockResolvedValue({ processed: true }),
    } as unknown as BillingSettlementService;
    const vouchers = {
      releaseByOrder: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VoucherService>;
    const credits = {
      list: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<CreditBalanceService>;
    const service = new BillingService(
      plans as unknown as Repository<BillingPlanEntity>,
      creditPackages as unknown as Repository<BillingCreditPackageEntity>,
      features as unknown as Repository<PlanFeatureEntity>,
      orders as unknown as Repository<PaymentOrderEntity>,
      entitlements,
      checkout,
      webhooks,
      providers,
      settlement,
      vouchers,
      credits,
    ) as BillingService;
    return {
      service,
      plans,
      creditPackages,
      features,
      orders,
      provider,
      settlement,
      vouchers,
      execute,
    };
  }

  it('hides internal billing plans from the public plan list', async () => {
    const { service, plans, features } = setup();
    plans.find.mockResolvedValue([
      {
        code: BillingPlanCode.INTERNAL_QA,
        name: 'Internal QA',
        description: 'Unlimited internal testing plan',
        category: 'SUBSCRIPTION',
        interval: 'MONTHLY',
        priceVnd: 0,
        currency: 'VND',
        metadata: { internal: true },
      },
      {
        code: BillingPlanCode.FREE,
        name: 'Free',
        description: 'Free monthly starter plan',
        category: 'SUBSCRIPTION',
        interval: 'MONTHLY',
        priceVnd: 0,
        currency: 'VND',
        metadata: null,
      },
      {
        code: BillingPlanCode.PRO,
        name: 'Pro',
        description: 'Monthly AI career tools plan',
        category: 'SUBSCRIPTION',
        interval: 'MONTHLY',
        priceVnd: 99000,
        currency: 'VND',
        metadata: null,
      },
      {
        code: BillingPlanCode.PREMIUM,
        name: 'Premium',
        description: 'Monthly premium plan',
        category: 'SUBSCRIPTION',
        interval: 'MONTHLY',
        priceVnd: 199000,
        currency: 'VND',
        metadata: null,
      },
      {
        code: 'MENTOR_60',
        name: 'Mentor 60 minutes',
        description: 'One mentor session package',
        category: 'MENTOR_PACKAGE',
        interval: 'ONE_TIME',
        priceVnd: 500000,
        currency: 'VND',
        metadata: null,
      },
    ]);
    features.find.mockResolvedValue([
      {
        planCode: BillingPlanCode.INTERNAL_QA,
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: -1,
        period: BillingFeaturePeriod.MONTHLY,
      },
      {
        planCode: BillingPlanCode.FREE,
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 5,
        period: BillingFeaturePeriod.DAILY,
      },
      {
        planCode: BillingPlanCode.PRO,
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 30,
        period: BillingFeaturePeriod.MONTHLY,
      },
      {
        planCode: BillingPlanCode.PREMIUM,
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 80,
        period: BillingFeaturePeriod.MONTHLY,
      },
    ]);

    const result = await service.listPlans();

    expect(result.map((plan) => plan.code)).toEqual([
      BillingPlanCode.FREE,
      BillingPlanCode.PREMIUM,
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        code: BillingPlanCode.FREE,
        features: [
          {
            featureKey: BillingFeatureKey.CV_REVIEW,
            limit: 5,
            period: BillingFeaturePeriod.DAILY,
          },
        ],
      }),
      expect.objectContaining({
        code: BillingPlanCode.PREMIUM,
        features: [
          {
            featureKey: BillingFeatureKey.CV_REVIEW,
            limit: 80,
            period: BillingFeaturePeriod.MONTHLY,
          },
        ],
      }),
    ]);
  });

  it('settles a paid provider snapshot for an order owned by the current user', async () => {
    const { service, orders, provider, settlement } = setup();
    const pendingOrder = {
      id: 'order-1',
      userId: 'user-1',
      provider: 'PAYOS',
      orderCode: '123',
      amountVnd: 99000,
      currency: 'VND',
      purpose: 'SUBSCRIPTION',
      status: 'PENDING',
      checkoutUrl: 'https://pay.test',
      paymentLinkId: 'plink-1',
      targetType: 'SUBSCRIPTION',
      targetId: null,
      paidAt: null,
      createdAt: new Date('2026-06-09T00:00:00.000Z'),
      returnUrl: 'https://app.test/billing/checkout/123',
      cancelUrl: 'https://app.test/billing/checkout/123',
      lastProviderCheckAt: null,
    } as unknown as PaymentOrderEntity;
    const paidOrder = { ...pendingOrder, status: 'PAID', paidAt: new Date() } as PaymentOrderEntity;
    orders.findOne.mockResolvedValueOnce(pendingOrder).mockResolvedValueOnce(paidOrder);
    provider.getPaymentStatus.mockResolvedValue({
      provider: 'PAYOS',
      orderCode: 123,
      paymentLinkId: 'plink-1',
      reference: null,
      status: 'PAID',
      amountVnd: 99000,
      currency: 'VND',
      raw: {},
    });

    const result = await service.reconcileOrder('user-1', 123);

    expect(provider.getPaymentStatus).toHaveBeenCalledWith({ orderCode: 123 });
    expect(settlement.settlePaidPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'PAYOS',
        orderCode: 123,
        status: 'PAID',
        amountVnd: 99000,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        orderCode: 123,
        status: 'PAID',
        returnUrl: 'https://app.test/billing/checkout/123',
      }),
    );
  });

  it('does not settle when PayOS still reports a non-paid status', async () => {
    const { service, orders, provider, settlement } = setup();
    const pendingOrder = {
      id: 'order-1',
      userId: 'user-1',
      provider: 'PAYOS',
      orderCode: '123',
      amountVnd: 99000,
      currency: 'VND',
      purpose: 'SUBSCRIPTION',
      status: 'PENDING',
      checkoutUrl: 'https://pay.test',
      paymentLinkId: 'plink-1',
      targetType: 'SUBSCRIPTION',
      targetId: null,
      paidAt: null,
      createdAt: new Date('2026-06-09T00:00:00.000Z'),
    } as unknown as PaymentOrderEntity;
    orders.findOne.mockResolvedValue(pendingOrder);
    provider.getPaymentStatus.mockResolvedValue({
      provider: 'PAYOS',
      orderCode: 123,
      paymentLinkId: 'plink-1',
      reference: null,
      status: 'PENDING',
      amountVnd: 99000,
      currency: 'VND',
      raw: {},
    });

    const result = await service.reconcileOrder('user-1', 123);

    expect(settlement.settlePaidPayment).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ orderCode: 123, status: 'PENDING' }));
  });

  it('coalesces concurrent reconciliations behind one provider status check', async () => {
    const { service, orders, provider, execute } = setup();
    const pendingOrder = {
      id: 'order-1',
      userId: 'user-1',
      provider: 'PAYOS',
      orderCode: '123',
      amountVnd: 99000,
      originalAmountVnd: 99000,
      discountPercent: 0,
      discountAmountVnd: 0,
      voucherCode: null,
      currency: 'VND',
      purpose: 'SUBSCRIPTION',
      status: 'PENDING',
      checkoutUrl: 'https://pay.test',
      paymentLinkId: 'plink-1',
      returnUrl: 'https://app.test/billing/checkout/123',
      cancelUrl: 'https://app.test/billing/checkout/123',
      lastProviderCheckAt: null,
      targetType: 'SUBSCRIPTION',
      targetId: null,
      paidAt: null,
      createdAt: new Date('2026-06-09T00:00:00.000Z'),
    } as unknown as PaymentOrderEntity;
    orders.findOne.mockResolvedValue(pendingOrder);
    execute.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 });
    provider.getPaymentStatus.mockResolvedValue({
      provider: 'PAYOS',
      orderCode: 123,
      paymentLinkId: 'plink-1',
      reference: null,
      status: 'PENDING',
      amountVnd: 99000,
      currency: 'VND',
      raw: {},
    });

    const [first, second] = await Promise.all([
      service.reconcileOrder('user-1', 123),
      service.reconcileOrder('user-1', 123),
    ]);

    expect(provider.getPaymentStatus).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('PENDING');
    expect(second.status).toBe('PENDING');
  });

  it('syncs a provider cancelled status without granting entitlements', async () => {
    const { service, orders, provider, settlement, vouchers } = setup();
    const pendingOrder = {
      id: 'order-1',
      userId: 'user-1',
      provider: 'PAYOS',
      orderCode: '123',
      amountVnd: 99000,
      currency: 'VND',
      purpose: 'SUBSCRIPTION',
      status: 'PENDING',
      checkoutUrl: 'https://pay.test',
      paymentLinkId: 'plink-1',
      targetType: 'SUBSCRIPTION',
      targetId: null,
      paidAt: null,
      createdAt: new Date('2026-06-09T00:00:00.000Z'),
    } as PaymentOrderEntity;
    const cancelledOrder = { ...pendingOrder, status: 'CANCELLED' } as PaymentOrderEntity;
    orders.findOne.mockResolvedValueOnce(pendingOrder).mockResolvedValueOnce(cancelledOrder);
    provider.getPaymentStatus.mockResolvedValue({
      provider: 'PAYOS',
      orderCode: 123,
      paymentLinkId: 'plink-1',
      reference: null,
      status: 'CANCELLED',
      amountVnd: 99000,
      currency: 'VND',
      raw: {},
    });

    const result = await service.reconcileOrder('user-1', 123);

    expect(settlement.settlePaidPayment).not.toHaveBeenCalled();
    expect(orders.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELLED' }));
    expect(vouchers.releaseByOrder).toHaveBeenCalledWith('order-1');
    expect(result).toEqual(expect.objectContaining({ orderCode: 123, status: 'CANCELLED' }));
  });
});
