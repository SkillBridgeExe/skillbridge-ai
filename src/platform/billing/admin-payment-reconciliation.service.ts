import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PaymentOrderEntity,
  PaymentOrderStatus,
} from '../../database/entities/payment-order.entity';
import {
  resolveAdminRevenueWindow,
  type AdminRevenueWindowQuery,
  type ResolvedAdminRevenueWindow,
} from '../users/admin-revenue-window';
import { AdminReconcilePaymentOrdersDto } from './dto/admin-billing.dto';
import { PaymentProviderRegistry } from './payment-providers/payment-provider.registry';
import {
  PaymentOrderReconciliationService,
  type PaymentOrderReconciliationResult,
} from './services/payment-order-reconciliation.service';

export type AdminPaymentReconciliationResultStatus = PaymentOrderStatus | 'FAILED_RECONCILIATION';

export type AdminPaymentReconciliationItem = {
  orderCode: number;
  status: AdminPaymentReconciliationResultStatus;
  message?: string;
};

export type AdminPaymentReconciliationResponse = {
  provider: string;
  window: {
    period: ResolvedAdminRevenueWindow['period'];
    from: string;
    to: string;
    timezone: ResolvedAdminRevenueWindow['timezone'];
  };
  attempted: number;
  settled: number;
  terminal: number;
  pending: number;
  failed: number;
  results: AdminPaymentReconciliationItem[];
};

const RECONCILIATION_CONCURRENCY = 4;

@Injectable()
export class AdminPaymentReconciliationService {
  constructor(
    @InjectRepository(PaymentOrderEntity)
    private readonly orders: Repository<PaymentOrderEntity>,
    private readonly providers: PaymentProviderRegistry,
    private readonly reconciliation: PaymentOrderReconciliationService,
  ) {}

  async reconcile(
    query: AdminReconcilePaymentOrdersDto | AdminRevenueWindowQuery = {},
  ): Promise<AdminPaymentReconciliationResponse> {
    const window = resolveAdminRevenueWindow(query);
    const provider = this.providers.activeProviderCode();
    const pendingOrders = await this.findPendingOrders(provider, window);
    const results = await mapWithConcurrency(pendingOrders, RECONCILIATION_CONCURRENCY, (order) =>
      this.reconcileOne(order),
    );

    return {
      provider,
      window: serializeWindow(window),
      attempted: results.length,
      settled: results.filter((result) => result.status === 'PAID').length,
      terminal: results.filter((result) =>
        ['CANCELLED', 'EXPIRED', 'FAILED'].includes(result.status),
      ).length,
      pending: results.filter((result) => result.status === 'PENDING').length,
      failed: results.filter((result) => result.status === 'FAILED_RECONCILIATION').length,
      results,
    };
  }

  private async findPendingOrders(
    provider: string,
    window: ResolvedAdminRevenueWindow,
  ): Promise<PaymentOrderEntity[]> {
    return this.orders
      .createQueryBuilder('order')
      .where('order.status = :status', { status: 'PENDING' })
      .andWhere('order.provider = :provider', { provider })
      .andWhere('order.currency = :currency', { currency: 'VND' })
      .andWhere('order.created_at < :windowTo', { windowTo: window.to })
      .andWhere('(order.expires_at IS NULL OR order.expires_at >= :windowFrom)', {
        windowFrom: window.from,
      })
      .orderBy('order.created_at', 'ASC')
      .getMany();
  }

  private async reconcileOne(order: PaymentOrderEntity): Promise<AdminPaymentReconciliationItem> {
    try {
      const result: PaymentOrderReconciliationResult =
        await this.reconciliation.reconcilePendingOrder(order);
      return { orderCode: Number(order.orderCode), status: result.status };
    } catch (error) {
      return {
        orderCode: Number(order.orderCode),
        status: 'FAILED_RECONCILIATION',
        message: safeErrorMessage(error),
      };
    }
  }
}

function serializeWindow(window: ResolvedAdminRevenueWindow) {
  return {
    period: window.period,
    from: window.fromDate,
    to: window.toDate,
    timezone: window.timezone,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return 'Payment provider reconciliation failed';
  return error.message.slice(0, 240);
}
