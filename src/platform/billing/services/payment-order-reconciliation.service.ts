import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PaymentOrderEntity,
  PaymentOrderProviderVerificationStatus,
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

export type PaymentOrderProviderVerificationResult = {
  status: PaymentOrderProviderVerificationStatus;
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

  async verifyPaidOrder(
    order: PaymentOrderEntity,
  ): Promise<PaymentOrderProviderVerificationResult> {
    if (order.status !== 'PAID') {
      return { status: 'NOT_PAID', attempted: false };
    }
    if (order.providerVerificationStatus === 'CONFIRMED_PAID') {
      return { status: 'CONFIRMED_PAID', attempted: false };
    }

    const claimed = await this.claimProviderCheck(order.id);
    if (!claimed) {
      return {
        status: order.providerVerificationStatus ?? 'ERROR',
        attempted: false,
      };
    }

    const verificationAt = new Date();
    let snapshot: PaymentStatusSnapshot;
    try {
      const provider = this.providers.get(order.provider);
      snapshot = await provider.getPaymentStatus({ orderCode: Number(order.orderCode) });
    } catch (error) {
      order.providerVerificationStatus = 'ERROR';
      order.providerVerifiedAt = verificationAt;
      await this.orders.save(order);
      throw error;
    }

    const status = classifyPaidOrderVerification(order, snapshot);
    order.providerVerificationStatus = status;
    order.providerVerifiedAt = verificationAt;
    await this.orders.save(order);
    return { status, attempted: true };
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

function classifyPaidOrderVerification(
  order: PaymentOrderEntity,
  snapshot: PaymentStatusSnapshot,
): PaymentOrderProviderVerificationStatus {
  if (snapshot.status === 'EXPIRED') return 'NOT_FOUND';
  if (snapshot.status !== 'PAID') return 'NOT_PAID';
  if (
    snapshot.amountVnd !== order.amountVnd ||
    snapshot.currency !== order.currency ||
    !snapshot.paymentLinkId ||
    (order.paymentLinkId !== null && order.paymentLinkId !== snapshot.paymentLinkId)
  ) {
    return 'MISMATCH';
  }
  return 'CONFIRMED_PAID';
}

export function isTerminalNonPaidStatus(
  status: string,
): status is Exclude<PaymentOrderStatus, 'PENDING' | 'PAID'> {
  return status === 'CANCELLED' || status === 'EXPIRED' || status === 'FAILED';
}
