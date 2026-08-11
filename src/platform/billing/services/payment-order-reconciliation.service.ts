import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PaymentOrderEntity,
  PaymentOrderStatus,
} from '../../../database/entities/payment-order.entity';
import { PaymentProviderRegistry } from '../payment-providers/payment-provider.registry';
import { PaymentStatusSnapshot } from '../payment-providers/payment-provider.port';
import { VoucherService } from '../voucher.service';
import { BillingSettlementService } from './billing-settlement.service';

export type PaymentOrderReconciliationResult = {
  status: PaymentOrderStatus;
  attempted: boolean;
};

@Injectable()
export class PaymentOrderReconciliationService {
  private readonly logger = new Logger(PaymentOrderReconciliationService.name);

  constructor(
    @InjectRepository(PaymentOrderEntity)
    private readonly orders: Repository<PaymentOrderEntity>,
    private readonly providers: PaymentProviderRegistry,
    private readonly settlement: BillingSettlementService,
    private readonly vouchers: VoucherService,
  ) {}

  async reconcilePendingOrder(
    order: PaymentOrderEntity,
  ): Promise<PaymentOrderReconciliationResult> {
    if (order.status !== 'PENDING') {
      return { status: order.status, attempted: false };
    }

    const claimed = await this.claimProviderCheck(order.id);
    if (!claimed) return { status: 'PENDING', attempted: false };

    const provider = this.providers.get(order.provider);
    let snapshot: PaymentStatusSnapshot;
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
      return { status: 'PAID', attempted: true };
    }

    if (isTerminalNonPaidStatus(snapshot.status)) {
      order.status = snapshot.status;
      order.paymentLinkId = order.paymentLinkId ?? snapshot.paymentLinkId;
      await this.orders.save(order);
      await this.vouchers.releaseByOrder(order.id);
      return { status: snapshot.status, attempted: true };
    }

    return { status: 'PENDING', attempted: true };
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
}

export function isTerminalNonPaidStatus(
  status: string,
): status is Exclude<PaymentOrderStatus, 'PENDING' | 'PAID'> {
  return status === 'CANCELLED' || status === 'EXPIRED' || status === 'FAILED';
}
