import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ERROR_CODES } from '../../../common/constants/error-codes';
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
    private readonly dataSource: DataSource,
  ) {}

  async settlePaidPayment(payment: VerifiedPaymentWebhook): Promise<{ processed: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const orders = manager.getRepository(PaymentOrderEntity);
      const subscriptions = manager.getRepository(UserSubscriptionEntity);
      const mentorBookings = manager.getRepository(MentorBookingEntity);
      const order = await orders.findOne({
        where: { provider: payment.provider, orderCode: String(payment.orderCode) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) return { processed: true };
      await this.markOrderPaid(order, payment, orders, subscriptions, mentorBookings);
      return { processed: true };
    });
  }

  private async markOrderPaid(
    order: PaymentOrderEntity,
    payment: VerifiedPaymentWebhook,
    orders: Repository<PaymentOrderEntity>,
    subscriptions: Repository<UserSubscriptionEntity>,
    mentorBookings: Repository<MentorBookingEntity>,
  ): Promise<void> {
    if (order.status === 'PAID') return;
    this.assertPaymentMatchesOrder(order, payment);
    order.paidAt = order.paidAt ?? new Date();
    order.paymentLinkId = order.paymentLinkId ?? payment.paymentLinkId;

    if (order.purpose === 'SUBSCRIPTION') {
      await this.activateSubscription(order, subscriptions);
    } else if (order.targetType === 'MENTOR_BOOKING' && order.targetId) {
      await this.updateMentorBookingAfterPayment(order, mentorBookings);
    }

    order.status = 'PAID';
    await orders.save(order);
  }

  private assertPaymentMatchesOrder(
    order: PaymentOrderEntity,
    payment: VerifiedPaymentWebhook,
  ): void {
    if (payment.amountVnd !== null && order.amountVnd !== payment.amountVnd) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.PAYMENT_PROVIDER_ERROR,
        message: 'Payment amount does not match the local order',
      });
    }
    if (payment.currency && order.currency !== payment.currency) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.PAYMENT_PROVIDER_ERROR,
        message: 'Payment currency does not match the local order',
      });
    }
    if (order.paymentLinkId && payment.paymentLinkId && order.paymentLinkId !== payment.paymentLinkId) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.PAYMENT_PROVIDER_ERROR,
        message: 'Payment link does not match the local order',
      });
    }
  }

  private async activateSubscription(
    order: PaymentOrderEntity,
    subscriptions: Repository<UserSubscriptionEntity>,
  ): Promise<void> {
    if (!order.planCode) return;
    const existingSubscription = await subscriptions.findOne({
      where: { sourcePaymentOrderId: order.id },
    });
    if (existingSubscription) return;
    await subscriptions.update(
      { userId: order.userId, status: 'ACTIVE' },
      { status: 'EXPIRED' },
    );
    const periodStart = new Date();
    await subscriptions.save(
      subscriptions.create({
        userId: order.userId,
        planCode: order.planCode,
        status: 'ACTIVE',
        currentPeriodStart: periodStart,
        currentPeriodEnd: addMonths(periodStart, 1),
        sourcePaymentOrderId: order.id,
      }),
    );
  }

  private async updateMentorBookingAfterPayment(
    order: PaymentOrderEntity,
    mentorBookings: Repository<MentorBookingEntity>,
  ): Promise<void> {
    const booking = await mentorBookings.findOne({ where: { id: order.targetId! } });
    if (!booking) return;
    if (order.purpose === 'MENTOR_DEPOSIT') {
      booking.status = 'AWAITING_MENTOR_ACCEPT';
      booking.depositPaymentOrderId = order.id;
    }
    if (order.purpose === 'MENTOR_REMAINING') {
      booking.status = 'PAID';
      booking.remainingPaymentOrderId = order.id;
    }
    await mentorBookings.save(booking);
  }
}
