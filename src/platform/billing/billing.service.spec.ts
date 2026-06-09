import { Repository } from 'typeorm';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { EntitlementsService } from './entitlements.service';
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
    };
    const providers = { get: jest.fn().mockReturnValue(provider) } as unknown as PaymentProviderRegistry;
    const settlement = {
      settlePaidPayment: jest.fn().mockResolvedValue({ processed: true }),
    } as unknown as BillingSettlementService;
    const service = new (BillingService as any)(
      plans,
      features,
      orders,
      entitlements,
      checkout,
      webhooks,
      providers,
      settlement,
    ) as BillingService;
    return { service, orders, provider, settlement };
  }

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

    const result = await (service as any).reconcileOrder('user-1', 123);

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

    const result = await (service as any).reconcileOrder('user-1', 123);

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

    const result = await (service as any).reconcileOrder('user-1', 123);

    expect(settlement.settlePaidPayment).not.toHaveBeenCalled();
    expect(orders.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELLED' }));
    expect(result).toEqual(expect.objectContaining({ orderCode: 123, status: 'CANCELLED' }));
  });
});
