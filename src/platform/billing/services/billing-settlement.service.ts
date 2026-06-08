import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MentorBookingEntity } from '../../../database/entities/mentor-booking.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { UserSubscriptionEntity } from '../../../database/entities/user-subscription.entity';
import { addMonths } from '../entitlements.service';
import { VerifiedPaymentWebhook } from '../payment-providers/payment-provider.port';

@Injectable()
export class BillingSettlementService {
  constructor(
    @InjectRepository(PaymentOrderEntity) private readonly orders: Repository<PaymentOrderEntity>,
    @InjectRepository(UserSubscriptionEntity)
    private readonly subscriptions: Repository<UserSubscriptionEntity>,
    @InjectRepository(MentorBookingEntity)
    private readonly mentorBookings: Repository<MentorBookingEntity>,
  ) {}

  async settlePaidPayment(payment: VerifiedPaymentWebhook): Promise<{ processed: boolean }> {
    const order = await this.orders.findOne({
      where: { provider: payment.provider, orderCode: String(payment.orderCode) },
    });
    if (!order) return { processed: true };
    await this.markOrderPaid(order, payment.paymentLinkId);
    return { processed: true };
  }

  private async markOrderPaid(
    order: PaymentOrderEntity,
    paymentLinkId: string | null,
  ): Promise<void> {
    if (order.status === 'PAID') return;
    order.paidAt = order.paidAt ?? new Date();
    order.paymentLinkId = order.paymentLinkId ?? paymentLinkId;

    if (order.purpose === 'SUBSCRIPTION') {
      await this.activateSubscription(order);
    } else if (order.targetType === 'MENTOR_BOOKING' && order.targetId) {
      await this.updateMentorBookingAfterPayment(order);
    }

    order.status = 'PAID';
    await this.orders.save(order);
  }

  private async activateSubscription(order: PaymentOrderEntity): Promise<void> {
    if (!order.planCode) return;
    const existingSubscription = await this.subscriptions.findOne({
      where: { sourcePaymentOrderId: order.id },
    });
    if (existingSubscription) return;
    await this.subscriptions.update(
      { userId: order.userId, status: 'ACTIVE' },
      { status: 'EXPIRED' },
    );
    const periodStart = new Date();
    await this.subscriptions.save(
      this.subscriptions.create({
        userId: order.userId,
        planCode: order.planCode,
        status: 'ACTIVE',
        currentPeriodStart: periodStart,
        currentPeriodEnd: addMonths(periodStart, 1),
        sourcePaymentOrderId: order.id,
      }),
    );
  }

  private async updateMentorBookingAfterPayment(order: PaymentOrderEntity): Promise<void> {
    const booking = await this.mentorBookings.findOne({ where: { id: order.targetId! } });
    if (!booking) return;
    if (order.purpose === 'MENTOR_DEPOSIT') {
      if (booking.depositPaymentOrderId === order.id) return;
      booking.status = 'AWAITING_MENTOR_ACCEPT';
      booking.depositPaymentOrderId = order.id;
    }
    if (order.purpose === 'MENTOR_REMAINING') {
      if (booking.remainingPaymentOrderId === order.id) return;
      booking.status = 'PAID';
      booking.remainingPaymentOrderId = order.id;
    }
    await this.mentorBookings.save(booking);
  }
}
