import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityTarget, Repository } from 'typeorm';
import { MentorBookingEntity } from '../../../database/entities/mentor-booking.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { UserSubscriptionEntity } from '../../../database/entities/user-subscription.entity';
import { BillingSettlementService } from './billing-settlement.service';

type RepoMock<T extends object> = Pick<
  Repository<T>,
  'create' | 'findOne' | 'save' | 'update'
> & {
  create: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
};

function repo<T extends object>(): RepoMock<T> {
  return {
    create: jest.fn((input) => input),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve(input)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as RepoMock<T>;
}

function setup() {
  const orders = repo<PaymentOrderEntity>();
  const subscriptions = repo<UserSubscriptionEntity>();
  const mentorBookings = repo<MentorBookingEntity>();
  const repos = new Map<EntityTarget<unknown>, unknown>([
    [PaymentOrderEntity, orders],
    [UserSubscriptionEntity, subscriptions],
    [MentorBookingEntity, mentorBookings],
  ]);
  const dataSource = {
    transaction: jest.fn(async (work: (manager: { getRepository: Function }) => Promise<unknown>) =>
      work({
        getRepository: (entity: EntityTarget<unknown>) => repos.get(entity),
      }),
    ),
  } as unknown as DataSource;
  const service = new (BillingSettlementService as any)(
    orders,
    subscriptions,
    mentorBookings,
    dataSource,
  ) as BillingSettlementService;
  return { service, orders, subscriptions, mentorBookings, dataSource };
}

describe('BillingSettlementService', () => {
  it('settles a paid subscription inside a transaction after validating amount and payment link', async () => {
    const { service, orders, subscriptions, dataSource } = setup();
    const order = {
      id: 'order-1',
      userId: 'user-1',
      provider: 'PAYOS',
      orderCode: '123',
      amountVnd: 99000,
      currency: 'VND',
      purpose: 'SUBSCRIPTION',
      targetType: 'SUBSCRIPTION',
      targetId: null,
      planCode: 'PRO',
      status: 'PENDING',
      paymentLinkId: 'plink-1',
      paidAt: null,
    } as PaymentOrderEntity;
    orders.findOne.mockResolvedValue(order);
    subscriptions.findOne.mockResolvedValue(null);

    await service.settlePaidPayment({
      provider: 'PAYOS',
      orderCode: 123,
      paymentLinkId: 'plink-1',
      reference: 'ref-1',
      status: 'PAID',
      amountVnd: 99000,
      currency: 'VND',
      raw: {},
    });

    expect(dataSource.transaction).toHaveBeenCalled();
    expect(subscriptions.update).toHaveBeenCalledWith(
      { userId: 'user-1', status: 'ACTIVE' },
      { status: 'EXPIRED' },
    );
    expect(subscriptions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        planCode: 'PRO',
        status: 'ACTIVE',
        sourcePaymentOrderId: 'order-1',
      }),
    );
    expect(orders.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PAID', paidAt: expect.any(Date) }),
    );
  });

  it('rejects paid settlement when PayOS amount does not match the local order', async () => {
    const { service, orders, subscriptions } = setup();
    orders.findOne.mockResolvedValue({
      id: 'order-1',
      userId: 'user-1',
      provider: 'PAYOS',
      orderCode: '123',
      amountVnd: 99000,
      currency: 'VND',
      purpose: 'SUBSCRIPTION',
      targetType: 'SUBSCRIPTION',
      planCode: 'PRO',
      status: 'PENDING',
      paymentLinkId: 'plink-1',
      paidAt: null,
    } as PaymentOrderEntity);

    await expect(
      service.settlePaidPayment({
        provider: 'PAYOS',
        orderCode: 123,
        paymentLinkId: 'plink-1',
        reference: 'ref-1',
        status: 'PAID',
        amountVnd: 98000,
        currency: 'VND',
        raw: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(subscriptions.save).not.toHaveBeenCalled();
    expect(orders.save).not.toHaveBeenCalled();
  });

  it('moves mentor deposit bookings forward even when the order id is already linked', async () => {
    const { service, orders, mentorBookings } = setup();
    orders.findOne.mockResolvedValue({
      id: 'order-1',
      userId: 'student-1',
      provider: 'PAYOS',
      orderCode: '123',
      amountVnd: 10000,
      currency: 'VND',
      purpose: 'MENTOR_DEPOSIT',
      targetType: 'MENTOR_BOOKING',
      targetId: 'booking-1',
      planCode: 'MENTOR_60',
      status: 'PENDING',
      paymentLinkId: 'plink-1',
      paidAt: null,
    } as PaymentOrderEntity);
    mentorBookings.findOne.mockResolvedValue({
      id: 'booking-1',
      status: 'PENDING_DEPOSIT',
      depositPaymentOrderId: 'order-1',
      remainingPaymentOrderId: null,
    } as MentorBookingEntity);

    await service.settlePaidPayment({
      provider: 'PAYOS',
      orderCode: 123,
      paymentLinkId: 'plink-1',
      reference: 'ref-1',
      status: 'PAID',
      amountVnd: 10000,
      currency: 'VND',
      raw: {},
    });

    expect(mentorBookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-1',
        status: 'AWAITING_MENTOR_ACCEPT',
        depositPaymentOrderId: 'order-1',
      }),
    );
  });
});
