import { Repository } from 'typeorm';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { PaymentProviderRegistry } from './payment-providers/payment-provider.registry';
import { PaymentOrderReconciliationService } from './services/payment-order-reconciliation.service';
import { AdminPaymentReconciliationService } from './admin-payment-reconciliation.service';

function pendingOrder(orderCode: number): PaymentOrderEntity {
  return {
    id: `order-${orderCode}`,
    orderCode: String(orderCode),
    provider: 'PAYOS',
    currency: 'VND',
    status: 'PENDING',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
  } as PaymentOrderEntity;
}

function setup(ordersToReturn: PaymentOrderEntity[] = []) {
  const getMany = jest.fn().mockResolvedValue(ordersToReturn);
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany,
  };
  const orders = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  } as unknown as jest.Mocked<Pick<Repository<PaymentOrderEntity>, 'createQueryBuilder'>>;
  const providers = {
    activeProviderCode: jest.fn().mockReturnValue('PAYOS'),
  } as unknown as jest.Mocked<Pick<PaymentProviderRegistry, 'activeProviderCode'>>;
  const reconciliation = {
    reconcilePendingOrder: jest.fn(),
  } as unknown as jest.Mocked<Pick<PaymentOrderReconciliationService, 'reconcilePendingOrder'>>;
  const service = new AdminPaymentReconciliationService(
    orders as unknown as Repository<PaymentOrderEntity>,
    providers as unknown as PaymentProviderRegistry,
    reconciliation as unknown as PaymentOrderReconciliationService,
  );
  return { service, orders, queryBuilder, getMany, providers, reconciliation };
}

describe('AdminPaymentReconciliationService', () => {
  it('selects pending active-provider VND orders whose lifetime intersects the window', async () => {
    const { service, queryBuilder } = setup([]);

    const result = await service.reconcile({
      period: 'CUSTOM',
      from: '2026-08-01',
      to: '2026-08-11',
    });

    expect(queryBuilder.where).toHaveBeenCalledWith('order.status = :status', {
      status: 'PENDING',
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('order.provider = :provider', {
      provider: 'PAYOS',
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('order.currency = :currency', {
      currency: 'VND',
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('order.created_at < :windowTo', {
      windowTo: new Date('2026-08-11T17:00:00.000Z'),
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '(order.expires_at IS NULL OR order.expires_at >= :windowFrom)',
      { windowFrom: new Date('2026-07-31T17:00:00.000Z') },
    );
    expect(result).toEqual(
      expect.objectContaining({
        provider: 'PAYOS',
        attempted: 0,
        settled: 0,
        terminal: 0,
        pending: 0,
        failed: 0,
        window: expect.objectContaining({ period: 'CUSTOM' }),
      }),
    );
  });

  it('reports settled, terminal, pending, and failed orders independently', async () => {
    const rows = [1, 2, 3, 4].map(pendingOrder);
    const { service, reconciliation } = setup(rows);
    reconciliation.reconcilePendingOrder.mockImplementation(async (order) => {
      switch (Number(order.orderCode)) {
        case 1:
          return { status: 'PAID', attempted: true };
        case 2:
          return { status: 'CANCELLED', attempted: true };
        case 3:
          return { status: 'PENDING', attempted: true };
        default:
          throw new Error('provider rate limited');
      }
    });

    const result = await service.reconcile({ period: 'THIS_YEAR' });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: 4,
        settled: 1,
        terminal: 1,
        pending: 1,
        failed: 1,
      }),
    );
    expect(result.results).toEqual(
      expect.arrayContaining([
        { orderCode: 1, status: 'PAID' },
        { orderCode: 2, status: 'CANCELLED' },
        { orderCode: 3, status: 'PENDING' },
        { orderCode: 4, status: 'FAILED_RECONCILIATION', message: 'provider rate limited' },
      ]),
    );
  });

  it('limits concurrent provider checks to four orders', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => pendingOrder(index + 1));
    const { service, reconciliation } = setup(rows);
    let active = 0;
    let maximum = 0;
    reconciliation.reconcilePendingOrder.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { status: 'PENDING', attempted: true };
    });

    await service.reconcile({ period: 'THIS_YEAR' });

    expect(maximum).toBeLessThanOrEqual(4);
    expect(reconciliation.reconcilePendingOrder).toHaveBeenCalledTimes(11);
  });
});
