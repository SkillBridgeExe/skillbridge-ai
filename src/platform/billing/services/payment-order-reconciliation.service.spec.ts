import { Repository } from 'typeorm';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { PaymentProviderPort } from '../payment-providers/payment-provider.port';
import { PaymentProviderRegistry } from '../payment-providers/payment-provider.registry';
import { BillingSettlementService } from './billing-settlement.service';
import { PaymentOrderReconciliationService } from './payment-order-reconciliation.service';
import { VoucherService } from '../voucher.service';

function order(overrides: Partial<PaymentOrderEntity> = {}): PaymentOrderEntity {
  return {
    id: 'order-1',
    provider: 'PAYOS',
    orderCode: '123',
    status: 'PENDING',
    amountVnd: 99000,
    currency: 'VND',
    paymentLinkId: 'plink-1',
    lastProviderCheckAt: null,
    ...overrides,
  } as PaymentOrderEntity;
}

function setup() {
  const orders = {
    createQueryBuilder: jest.fn(),
    save: jest.fn((value) => Promise.resolve(value)),
  } as unknown as jest.Mocked<Pick<Repository<PaymentOrderEntity>, 'createQueryBuilder' | 'save'>>;
  const execute = jest.fn().mockResolvedValue({ affected: 1 });
  orders.createQueryBuilder.mockReturnValue({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute,
  } as never);
  const provider = {
    getPaymentStatus: jest.fn(),
  } as unknown as jest.Mocked<PaymentProviderPort>;
  const providers = {
    get: jest.fn().mockReturnValue(provider),
  } as unknown as jest.Mocked<PaymentProviderRegistry>;
  const settlement = {
    settlePaidPayment: jest.fn().mockResolvedValue({ processed: true }),
  } as unknown as jest.Mocked<BillingSettlementService>;
  const vouchers = {
    releaseByOrder: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<VoucherService>;
  const service = new PaymentOrderReconciliationService(
    orders as unknown as Repository<PaymentOrderEntity>,
    providers,
    settlement,
    vouchers,
  );
  return { service, orders, execute, provider, providers, settlement, vouchers };
}

describe('PaymentOrderReconciliationService', () => {
  it('settles a provider-paid pending order through BillingSettlementService', async () => {
    const { service, provider, settlement } = setup();
    const pending = order();
    const snapshot = {
      provider: 'PAYOS',
      orderCode: 123,
      paymentLinkId: 'plink-1',
      reference: 'ref-1',
      status: 'PAID' as const,
      amountVnd: 99000,
      currency: 'VND',
      paidAt: new Date('2026-08-11T05:34:56.000Z'),
      raw: {},
    };
    provider.getPaymentStatus.mockResolvedValue(snapshot);

    const result = await service.reconcilePendingOrder(pending);

    expect(provider.getPaymentStatus).toHaveBeenCalledWith({ orderCode: 123 });
    expect(settlement.settlePaidPayment).toHaveBeenCalledWith(snapshot);
    expect(result).toEqual({ status: 'PAID', attempted: true });
  });

  it('persists terminal provider statuses and releases the voucher reservation', async () => {
    const { service, provider, orders, vouchers } = setup();
    const pending = order({ paymentLinkId: null });
    provider.getPaymentStatus.mockResolvedValue({
      provider: 'PAYOS',
      orderCode: 123,
      paymentLinkId: 'plink-from-provider',
      reference: null,
      status: 'CANCELLED',
      amountVnd: 99000,
      currency: 'VND',
      raw: {},
    });

    const result = await service.reconcilePendingOrder(pending);

    expect(orders.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CANCELLED',
        paymentLinkId: 'plink-from-provider',
      }),
    );
    expect(vouchers.releaseByOrder).toHaveBeenCalledWith('order-1');
    expect(result).toEqual({ status: 'CANCELLED', attempted: true });
  });

  it('leaves the order pending when the provider request fails', async () => {
    const { service, provider, orders, settlement } = setup();
    const error = new Error('PayOS unavailable');
    provider.getPaymentStatus.mockRejectedValue(error);

    await expect(service.reconcilePendingOrder(order())).rejects.toBe(error);

    expect(orders.save).not.toHaveBeenCalled();
    expect(settlement.settlePaidPayment).not.toHaveBeenCalled();
  });

  it('skips a concurrent attempt when the atomic provider-check claim is lost', async () => {
    const { service, execute, provider, settlement } = setup();
    execute.mockResolvedValue({ affected: 0 });

    const result = await service.reconcilePendingOrder(order());

    expect(provider.getPaymentStatus).not.toHaveBeenCalled();
    expect(settlement.settlePaidPayment).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'PENDING', attempted: false });
  });

  it('does not call the provider for an order already settled locally', async () => {
    const { service, provider, execute } = setup();

    const result = await service.reconcilePendingOrder(order({ status: 'PAID' }));

    expect(execute).not.toHaveBeenCalled();
    expect(provider.getPaymentStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'PAID', attempted: false });
  });
});
