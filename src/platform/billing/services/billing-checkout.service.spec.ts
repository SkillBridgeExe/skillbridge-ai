import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BillingPlanEntity } from '../../../database/entities/billing-plan.entity';
import { BillingCreditPackageEntity } from '../../../database/entities/billing-credit-package.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { PaymentProviderRegistry } from '../payment-providers/payment-provider.registry';
import { BillingCheckoutService } from './billing-checkout.service';
import { VoucherService } from '../voucher.service';

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
    const creditPackages = repo<BillingCreditPackageEntity>();
    const orders = repo<PaymentOrderEntity>();
    const provider = {
      code: 'PAYOS',
      createPaymentLink: jest.fn().mockResolvedValue({
        checkoutUrl: 'https://pay.test/checkout',
        paymentLinkId: 'plink-1',
        qrCode: 'qr',
        providerPayload: { ok: true },
        returnUrl: 'https://app.test/billing/checkout/123',
        cancelUrl: 'https://app.test/billing/checkout/123',
        expiresAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      verifyWebhook: jest.fn(),
    };
    const registry = {
      activeProviderCode: jest.fn().mockReturnValue('PAYOS'),
      get: jest.fn().mockReturnValue(provider),
    } as unknown as PaymentProviderRegistry;
    const vouchers = {
      reserve: jest.fn().mockResolvedValue({
        redemptionId: 'redemption-1',
        voucherId: 'voucher-1',
        voucherCode: 'SKILLBRIDGE10',
        originalAmountVnd: 199000,
        discountPercent: 10,
        discountAmountVnd: 19900,
        finalAmountVnd: 179100,
      }),
      attachOrder: jest.fn().mockResolvedValue(undefined),
      releaseReservation: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VoucherService>;

    const service = new BillingCheckoutService(
      plans as unknown as Repository<BillingPlanEntity>,
      creditPackages as unknown as Repository<BillingCreditPackageEntity>,
      orders as unknown as Repository<PaymentOrderEntity>,
      registry,
      vouchers,
    );
    return { service, plans, creditPackages, orders, provider, registry, vouchers };
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

    const result = await service.createCheckout(
      'user-1',
      {
        purpose: 'SUBSCRIPTION',
        planCode: 'PRO',
      },
      'https://skillbridgebuilder.com',
    );

    expect(orders.save).toHaveBeenCalledWith(expect.objectContaining({ provider: 'PAYOS' }));
    expect(provider.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({
        amountVnd: 129000,
        itemName: 'Pro',
        checkoutOrigin: 'https://skillbridgebuilder.com',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        orderId: 'order-1',
        checkoutUrl: 'https://pay.test/checkout',
        returnUrl: 'https://app.test/billing/checkout/123',
      }),
    );
    expect(orders.save).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: 'https://app.test/billing/checkout/123',
        cancelUrl: 'https://app.test/billing/checkout/123',
      }),
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

  it('creates a credit-package checkout from the server-owned product price and unit snapshot', async () => {
    const { service, creditPackages, orders, provider, vouchers } = setup();
    creditPackages.findOne.mockResolvedValue({
      id: 'package-cv',
      planCode: 'CV_ANALYSIS_PACK',
      creditType: 'CV_ANALYSIS',
      units: 2,
      plan: {
        id: 'plan-cv',
        code: 'CV_ANALYSIS_PACK',
        name: 'CV analyses',
        category: 'CREDIT_PACKAGE',
        interval: 'ONE_TIME',
        priceVnd: 20000,
        currency: 'VND',
        isActive: true,
      },
    });
    orders.save.mockImplementation((input) => Promise.resolve({ id: 'order-1', ...input }));

    const result = await service.createCheckout('user-1', {
      purpose: 'CREDIT_PACKAGE',
      planCode: 'CV_ANALYSIS_PACK',
    });

    expect(vouchers.reserve).not.toHaveBeenCalled();
    expect(creditPackages.findOne).toHaveBeenCalledWith({
      where: { planCode: 'CV_ANALYSIS_PACK' },
      relations: { plan: true },
    });
    expect(orders.save).toHaveBeenCalledWith(
      expect.objectContaining({
        amountVnd: 20000,
        purpose: 'CREDIT_PACKAGE',
        targetType: 'CREDIT_PACKAGE',
        planCode: 'CV_ANALYSIS_PACK',
        creditType: 'CV_ANALYSIS',
        creditUnits: 2,
      }),
    );
    expect(provider.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amountVnd: 20000, itemName: 'CV analyses' }),
    );
    expect(result.creditPackage).toEqual({ creditType: 'CV_ANALYSIS', units: 2 });
  });

  it('rejects voucher input for a credit-package checkout', async () => {
    const { service } = setup();

    await expect(
      service.createCheckout('user-1', {
        purpose: 'CREDIT_PACKAGE',
        planCode: 'CV_ANALYSIS_PACK',
        voucherCode: 'SKILLBRIDGE10',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reserves a voucher and sends the discounted amount to the provider', async () => {
    const { service, plans, orders, provider, vouchers } = setup();
    plans.findOne.mockResolvedValue({
      code: 'PREMIUM',
      name: 'Premium',
      category: 'SUBSCRIPTION',
      priceVnd: 199000,
      currency: 'VND',
    });
    orders.save.mockImplementation((input) => Promise.resolve({ id: 'order-1', ...input }));

    const result = await service.createCheckout('user-1', {
      purpose: 'SUBSCRIPTION',
      planCode: 'PREMIUM',
      voucherCode: 'SKILLBRIDGE10',
    });

    expect(vouchers.reserve).toHaveBeenCalledWith(
      'user-1',
      { planCode: 'PREMIUM', voucherCode: 'SKILLBRIDGE10' },
      expect.any(Date),
    );
    expect(orders.save).toHaveBeenCalledWith(
      expect.objectContaining({
        originalAmountVnd: 199000,
        discountPercent: 10,
        discountAmountVnd: 19900,
        amountVnd: 179100,
        voucherId: 'voucher-1',
        voucherCode: 'SKILLBRIDGE10',
      }),
    );
    expect(provider.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amountVnd: 179100, expiresAt: expect.any(Date) }),
    );
    expect(result.pricing).toEqual({
      originalAmountVnd: 199000,
      discountPercent: 10,
      discountAmountVnd: 19900,
      finalAmountVnd: 179100,
      voucherCode: 'SKILLBRIDGE10',
      currency: 'VND',
    });
  });

  it('creates a full mentor booking checkout through the active provider abstraction', async () => {
    const { service, orders, provider } = setup();
    orders.save.mockImplementation((input) => Promise.resolve({ id: 'order-1', ...input }));

    const result = await service.createMentorBookingCheckout({
      userId: 'student-1',
      bookingId: 'booking-1',
      amountVnd: 500000,
      currency: 'VND',
      checkoutOrigin: 'https://www.skillbridgebuilder.com',
    });

    expect(orders.save).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'MENTOR_BOOKING',
        targetType: 'MENTOR_BOOKING',
        targetId: 'booking-1',
        amountVnd: 500000,
      }),
    );
    expect(provider.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({
        amountVnd: 500000,
        itemName: 'Mentor session',
        checkoutOrigin: 'https://www.skillbridgebuilder.com',
      }),
    );
    expect(result).toEqual(expect.objectContaining({ orderId: 'order-1' }));
  });

  it('marks mentor orders failed when the provider link cannot be created', async () => {
    const { service, orders, provider } = setup();
    orders.save.mockImplementation((input) =>
      Promise.resolve({ id: 'order-1', createdAt: new Date(), ...input }),
    );
    provider.createPaymentLink.mockRejectedValue(new Error('payOS unavailable'));

    await expect(
      service.createMentorBookingCheckout({
        userId: 'student-1',
        bookingId: 'booking-1',
        amountVnd: 500000,
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
