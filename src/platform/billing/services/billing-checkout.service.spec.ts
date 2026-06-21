import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BillingPlanEntity } from '../../../database/entities/billing-plan.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { PaymentProviderRegistry } from '../payment-providers/payment-provider.registry';
import { BillingCheckoutService } from './billing-checkout.service';

type RepoMock<T extends object> = Pick<Repository<T>, 'create' | 'exist' | 'findOne' | 'save'> & {
  create: jest.Mock;
  exist: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
};

function repo<T extends object>(): RepoMock<T> {
  return {
    create: jest.fn((input) => input),
    exist: jest.fn().mockResolvedValue(false),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve({ id: 'saved-id', createdAt: new Date(), ...input })),
  } as unknown as RepoMock<T>;
}

describe('BillingCheckoutService', () => {
  function setup() {
    const plans = repo<BillingPlanEntity>();
    const orders = repo<PaymentOrderEntity>();
    const provider = {
      code: 'PAYOS',
      createPaymentLink: jest.fn().mockResolvedValue({
        checkoutUrl: 'https://pay.test/checkout',
        paymentLinkId: 'plink-1',
        qrCode: 'qr',
        providerPayload: { ok: true },
        expiresAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      verifyWebhook: jest.fn(),
    };
    const registry = {
      activeProviderCode: jest.fn().mockReturnValue('PAYOS'),
      get: jest.fn().mockReturnValue(provider),
    } as unknown as PaymentProviderRegistry;

    const service = new BillingCheckoutService(
      plans as unknown as Repository<BillingPlanEntity>,
      orders as unknown as Repository<PaymentOrderEntity>,
      registry,
    );
    return { service, plans, orders, provider, registry };
  }

  it('creates a subscription checkout through the active provider abstraction', async () => {
    const { service, plans, orders, provider } = setup();
    plans.findOne.mockResolvedValue({
      code: 'PRO',
      name: 'Pro',
      category: 'SUBSCRIPTION',
      priceVnd: 129000,
      currency: 'VND',
    });
    orders.save.mockImplementation((input) => Promise.resolve({ id: 'order-1', ...input }));

    const result = await service.createCheckout('user-1', {
      purpose: 'SUBSCRIPTION',
      planCode: 'PRO',
    });

    expect(orders.save).toHaveBeenCalledWith(expect.objectContaining({ provider: 'PAYOS' }));
    expect(provider.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amountVnd: 129000, itemName: 'Pro' }),
    );
    expect(result).toEqual(
      expect.objectContaining({ orderId: 'order-1', checkoutUrl: 'https://pay.test/checkout' }),
    );
  });

  it('rejects checkout for a free subscription plan before calling the provider', async () => {
    const { service, plans, provider } = setup();
    plans.findOne.mockResolvedValue({
      code: 'FREE',
      name: 'Free',
      category: 'SUBSCRIPTION',
      priceVnd: 0,
    });

    await expect(
      service.createCheckout('user-1', { purpose: 'SUBSCRIPTION', planCode: 'FREE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.createPaymentLink).not.toHaveBeenCalled();
  });

  it('marks mentor orders failed when the provider link cannot be created', async () => {
    const { service, orders, provider } = setup();
    orders.save.mockImplementation((input) =>
      Promise.resolve({ id: 'order-1', createdAt: new Date(), ...input }),
    );
    provider.createPaymentLink.mockRejectedValue(new Error('payOS unavailable'));

    await expect(
      service.createMentorDepositCheckout({
        userId: 'student-1',
        bookingId: 'booking-1',
        amountVnd: 50000,
        currency: 'VND',
      }),
    ).rejects.toThrow('payOS unavailable');

    expect(orders.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'order-1',
        status: 'FAILED',
      }),
    );
  });
});
