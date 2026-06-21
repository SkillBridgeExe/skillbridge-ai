import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget, Repository } from 'typeorm';
import { MentorBookingEntity } from '../../../database/entities/mentor-booking.entity';
import { MentorAvailabilitySlotEntity } from '../../../database/entities/mentor-availability-slot.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { UserSubscriptionEntity } from '../../../database/entities/user-subscription.entity';
import { BillingSettlementService } from './billing-settlement.service';

type RepoMock<T extends object> = Pick<Repository<T>, 'create' | 'findOne' | 'save' | 'update'> & {
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
  const mentorSlots = repo<MentorAvailabilitySlotEntity>();
  const repos = new Map<EntityTarget<unknown>, unknown>([
    [PaymentOrderEntity, orders],
    [UserSubscriptionEntity, subscriptions],
    [MentorBookingEntity, mentorBookings],
    [MentorAvailabilitySlotEntity, mentorSlots],
  ]);
  const manager = {
    getRepository: jest.fn((entity: EntityTarget<unknown>) => repos.get(entity)),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn(
      async <T>(work: (manager: EntityManager) => Promise<T>): Promise<T> => work(manager),
    ),
  } as unknown as DataSource;
  const service = new BillingSettlementService(
    orders as unknown as Repository<PaymentOrderEntity>,
    subscriptions as unknown as Repository<UserSubscriptionEntity>,
    mentorBookings as unknown as Repository<MentorBookingEntity>,
    mentorSlots as unknown as Repository<MentorAvailabilitySlotEntity>,
    dataSource,
  );
  return { service, orders, subscriptions, mentorBookings, mentorSlots, dataSource };
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

  it('confirms the held slot and opens remaining payment after the deposit settles', async () => {
    const { service, orders, mentorBookings, mentorSlots } = setup();
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
      availabilitySlotId: 'slot-1',
      slotStart: new Date(Date.now() + 48 * 60 * 60 * 1000),
      remainingDueAt: null,
    } as MentorBookingEntity);
    mentorSlots.findOne.mockResolvedValue({
      id: 'slot-1',
      status: 'HELD',
      heldByBookingId: 'booking-1',
      holdExpiresAt: new Date(Date.now() + 60_000),
    } as MentorAvailabilitySlotEntity);

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
        status: 'AWAITING_REMAINING',
        depositPaymentOrderId: 'order-1',
        remainingDueAt: expect.any(Date),
      }),
    );
    expect(mentorSlots.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'slot-1',
        status: 'BOOKED',
        heldByBookingId: null,
        holdExpiresAt: null,
      }),
    );
  });

  it('moves a booking to confirmed after the remaining payment settles', async () => {
    const { service, orders, mentorBookings } = setup();
    orders.findOne.mockResolvedValue({
      id: 'order-2',
      userId: 'student-1',
      provider: 'PAYOS',
      orderCode: '124',
      amountVnd: 90000,
      currency: 'VND',
      purpose: 'MENTOR_REMAINING',
      targetType: 'MENTOR_BOOKING',
      targetId: 'booking-1',
      planCode: null,
      status: 'PENDING',
      paymentLinkId: 'plink-2',
      paidAt: null,
    } as PaymentOrderEntity);
    mentorBookings.findOne.mockResolvedValue({
      id: 'booking-1',
      status: 'AWAITING_REMAINING',
      remainingPaymentOrderId: 'order-2',
    } as MentorBookingEntity);

    await service.settlePaidPayment({
      provider: 'PAYOS',
      orderCode: 124,
      paymentLinkId: 'plink-2',
      reference: 'ref-2',
      status: 'PAID',
      amountVnd: 90000,
      currency: 'VND',
      raw: {},
    });

    expect(mentorBookings.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'CONFIRMED', remainingPaymentOrderId: 'order-2' }),
    );
  });

  it('queues manual refund when a deposit arrives after the booking expired', async () => {
    const { service, orders, mentorBookings, mentorSlots } = setup();
    orders.findOne.mockResolvedValue({
      id: 'order-late',
      userId: 'student-1',
      provider: 'PAYOS',
      orderCode: '125',
      amountVnd: 50000,
      currency: 'VND',
      purpose: 'MENTOR_DEPOSIT',
      targetType: 'MENTOR_BOOKING',
      targetId: 'booking-expired',
      status: 'PENDING',
      paymentLinkId: 'plink-late',
      paidAt: null,
    } as PaymentOrderEntity);
    mentorBookings.findOne.mockResolvedValue({
      id: 'booking-expired',
      status: 'EXPIRED',
      refundStatus: 'NOT_REQUIRED',
      depositPaymentOrderId: 'order-late',
      availabilitySlotId: 'slot-1',
    } as MentorBookingEntity);

    await service.settlePaidPayment({
      provider: 'PAYOS',
      orderCode: 125,
      paymentLinkId: 'plink-late',
      reference: 'ref-late',
      status: 'PAID',
      amountVnd: 50000,
      currency: 'VND',
      raw: {},
    });

    expect(mentorBookings.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'EXPIRED', refundStatus: 'PENDING' }),
    );
    expect(mentorSlots.save).not.toHaveBeenCalled();
  });
});
