import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget, Repository } from 'typeorm';
import { MentorBookingEntity } from '../../../database/entities/mentor-booking.entity';
import { MentorAvailabilitySlotEntity } from '../../../database/entities/mentor-availability-slot.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { UserSubscriptionEntity } from '../../../database/entities/user-subscription.entity';
import { VoucherRedemptionEntity } from '../../../database/entities/voucher-redemption.entity';
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
  const voucherRedemptions = repo<VoucherRedemptionEntity>();
  const repos = new Map<EntityTarget<unknown>, unknown>([
    [PaymentOrderEntity, orders],
    [UserSubscriptionEntity, subscriptions],
    [MentorBookingEntity, mentorBookings],
    [MentorAvailabilitySlotEntity, mentorSlots],
    [VoucherRedemptionEntity, voucherRedemptions],
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
  return {
    service,
    orders,
    subscriptions,
    mentorBookings,
    mentorSlots,
    voucherRedemptions,
    dataSource,
  };
}

describe('BillingSettlementService', () => {
  it('settles a paid subscription inside a transaction after validating amount and payment link', async () => {
    const { service, orders, subscriptions, voucherRedemptions, dataSource } = setup();
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
    expect(voucherRedemptions.update).toHaveBeenCalledWith(
      { paymentOrderId: 'order-1' },
      { status: 'REDEEMED', redeemedAt: expect.any(Date) },
    );
  });

  it('redeems a voucher when a valid paid webhook arrives after its reservation was released', async () => {
    const { service, orders, subscriptions, voucherRedemptions } = setup();
    orders.findOne.mockResolvedValue({
      id: 'order-late-voucher',
      userId: 'user-1',
      provider: 'PAYOS',
      orderCode: '124',
      amountVnd: 179100,
      currency: 'VND',
      purpose: 'SUBSCRIPTION',
      targetType: 'SUBSCRIPTION',
      targetId: null,
      planCode: 'PREMIUM',
      status: 'PENDING',
      paymentLinkId: 'plink-late-voucher',
      paidAt: null,
    } as PaymentOrderEntity);
    subscriptions.findOne.mockResolvedValue(null);

    await service.settlePaidPayment({
      provider: 'PAYOS',
      orderCode: 124,
      paymentLinkId: 'plink-late-voucher',
      reference: 'ref-late-voucher',
      status: 'PAID',
      amountVnd: 179100,
      currency: 'VND',
      raw: {},
    });

    expect(voucherRedemptions.update).toHaveBeenCalledWith(
      { paymentOrderId: 'order-late-voucher' },
      { status: 'REDEEMED', redeemedAt: expect.any(Date) },
    );
    expect(orders.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-late-voucher', status: 'PAID' }),
    );
  });

  it('does not activate a subscription or redeem a voucher twice for a repeated paid webhook', async () => {
    const { service, orders, subscriptions, voucherRedemptions } = setup();
    orders.findOne.mockResolvedValue({
      id: 'order-paid',
      userId: 'user-1',
      provider: 'PAYOS',
      orderCode: '126',
      amountVnd: 179100,
      currency: 'VND',
      purpose: 'SUBSCRIPTION',
      targetType: 'SUBSCRIPTION',
      targetId: null,
      planCode: 'PREMIUM',
      status: 'PAID',
      paymentLinkId: 'plink-paid',
      paidAt: new Date('2026-07-29T00:00:00.000Z'),
    } as PaymentOrderEntity);

    await service.settlePaidPayment({
      provider: 'PAYOS',
      orderCode: 126,
      paymentLinkId: 'plink-paid',
      reference: 'ref-paid-repeat',
      status: 'PAID',
      amountVnd: 179100,
      currency: 'VND',
      raw: {},
    });

    expect(subscriptions.update).not.toHaveBeenCalled();
    expect(subscriptions.save).not.toHaveBeenCalled();
    expect(voucherRedemptions.update).not.toHaveBeenCalled();
    expect(orders.save).not.toHaveBeenCalled();
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

  it.each([
    ['currency', { amountVnd: 99000, currency: 'USD', paymentLinkId: 'plink-1' }],
    ['payment link', { amountVnd: 99000, currency: 'VND', paymentLinkId: 'plink-other' }],
    ['missing amount', { amountVnd: null, currency: 'VND', paymentLinkId: 'plink-1' }],
    ['missing currency', { amountVnd: 99000, currency: null, paymentLinkId: 'plink-1' }],
    ['missing payment link', { amountVnd: 99000, currency: 'VND', paymentLinkId: null }],
  ])('rejects paid settlement when the provider %s is invalid', async (_case, providerData) => {
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
        reference: 'ref-1',
        status: 'PAID',
        raw: {},
        ...providerData,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(subscriptions.save).not.toHaveBeenCalled();
    expect(orders.save).not.toHaveBeenCalled();
  });

  it('confirms the booking and books the held slot after the mentor booking payment settles', async () => {
    const { service, orders, mentorBookings, mentorSlots } = setup();
    orders.findOne.mockResolvedValue({
      id: 'order-1',
      userId: 'student-1',
      provider: 'PAYOS',
      orderCode: '123',
      amountVnd: 100000,
      currency: 'VND',
      purpose: 'MENTOR_BOOKING',
      targetType: 'MENTOR_BOOKING',
      targetId: 'booking-1',
      planCode: 'MENTOR_60',
      status: 'PENDING',
      paymentLinkId: 'plink-1',
      paidAt: null,
    } as PaymentOrderEntity);
    mentorBookings.findOne.mockResolvedValue({
      id: 'booking-1',
      status: 'PENDING_PAYMENT',
      paymentOrderId: 'order-1',
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
      amountVnd: 100000,
      currency: 'VND',
      raw: {},
    });

    expect(mentorBookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-1',
        status: 'CONFIRMED',
        paymentOrderId: 'order-1',
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

  it('queues manual refund when a mentor booking payment arrives after the booking expired', async () => {
    const { service, orders, mentorBookings, mentorSlots } = setup();
    orders.findOne.mockResolvedValue({
      id: 'order-late',
      userId: 'student-1',
      provider: 'PAYOS',
      orderCode: '125',
      amountVnd: 500000,
      currency: 'VND',
      purpose: 'MENTOR_BOOKING',
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
      paymentOrderId: 'order-late',
      availabilitySlotId: 'slot-1',
    } as MentorBookingEntity);

    await service.settlePaidPayment({
      provider: 'PAYOS',
      orderCode: 125,
      paymentLinkId: 'plink-late',
      reference: 'ref-late',
      status: 'PAID',
      amountVnd: 500000,
      currency: 'VND',
      raw: {},
    });

    expect(mentorBookings.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'EXPIRED', refundStatus: 'PENDING' }),
    );
    expect(mentorSlots.save).not.toHaveBeenCalled();
  });
});
