import { Repository } from 'typeorm';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
  BillingPlanCode,
} from '../../common/constants/billing.constants';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { EntitlementsService } from './entitlements.service';
import { PaymentProviderPort } from './payment-providers/payment-provider.port';
import { PaymentProviderRegistry } from './payment-providers/payment-provider.registry';
import { BillingService } from './billing.service';
import { BillingCheckoutService } from './services/billing-checkout.service';
import { BillingSettlementService } from './services/billing-settlement.service';
import { PaymentWebhookService } from './services/payment-webhook.service';

type RepoMock<T extends object> = Pick<Repository<T>, 'find' | 'findOne' | 'save'> & {
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
};

function repo<T extends object>(): RepoMock<T> {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve(input)),
  } as unknown as RepoMock<T>;
}

describe('BillingService reconcileOrder', () => {
  function setup() {
    const plans = repo<BillingPlanEntity>();
    const features = repo<PlanFeatureEntity>();
    const orders = repo<PaymentOrderEntity>();
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
    const service = new BillingService(
      plans as unknown as Repository<BillingPlanEntity>,
      features as unknown as Repository<PlanFeatureEntity>,
      orders as unknown as Repository<PaymentOrderEntity>,
      entitlements,
      checkout,
      webhooks,
      providers,
      settlement,
    ) as BillingService;
    return { service, plans, features, orders, provider, settlement };
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
    ]);

    const result = await service.listPlans();

    expect(result.map((plan) => plan.code)).toEqual([BillingPlanCode.FREE, BillingPlanCode.PRO]);
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
        code: BillingPlanCode.PRO,
        features: [
          {
            featureKey: BillingFeatureKey.CV_REVIEW,
            limit: 30,
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
    } as PaymentOrderEntity;
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
    expect(result).toEqual(expect.objectContaining({ orderCode: 123, status: 'PAID' }));
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
    } as PaymentOrderEntity;
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

  it('syncs a provider cancelled status without granting entitlements', async () => {
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
    expect(result).toEqual(expect.objectContaining({ orderCode: 123, status: 'CANCELLED' }));
  });
});
