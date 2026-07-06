import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget, Repository } from 'typeorm';
import { MentorAvailabilitySlotEntity } from '../../database/entities/mentor-availability-slot.entity';
import { MentorBookingEntity } from '../../database/entities/mentor-booking.entity';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import { MentorReviewEntity } from '../../database/entities/mentor-review.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { BillingCheckoutService } from '../billing/services/billing-checkout.service';
import { MentorBookingsService } from './mentor-bookings.service';

type RepoMock<T extends object> = Pick<
  Repository<T>,
  'create' | 'find' | 'findOne' | 'save' | 'update'
> & {
  create: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
};

function repo<T extends object>(): RepoMock<T> {
  return {
    create: jest.fn((input) => input),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn(async (input) => input),
    update: jest.fn(),
  } as unknown as RepoMock<T>;
}

const profile = {
  id: 'profile-1',
  userId: 'mentor-1',
  slug: 'mentor-one',
  status: 'APPROVED',
  isAcceptingBookings: true,
  sessionPriceVnd: 500000,
  sessionDurationMinutes: 60,
  currency: 'VND',
  headline: 'Backend mentor',
  ratingAverage: null,
  reviewCount: 0,
  completedSessions: 0,
} as MentorProfileEntity;

const openSlot = {
  id: 'slot-1',
  mentorProfileId: 'profile-1',
  startsAt: new Date('2026-06-23T02:00:00.000Z'),
  endsAt: new Date('2026-06-23T03:00:00.000Z'),
  status: 'OPEN',
  heldByBookingId: null,
  holdExpiresAt: null,
} as MentorAvailabilitySlotEntity;

describe('MentorBookingsService', () => {
  function setup(now = new Date('2026-06-21T00:00:00.000Z')) {
    const profiles = repo<MentorProfileEntity>();
    const slots = repo<MentorAvailabilitySlotEntity>();
    const bookings = repo<MentorBookingEntity>();
    const reviews = repo<MentorReviewEntity>();
    const orders = repo<PaymentOrderEntity>();
    const repos = new Map<EntityTarget<unknown>, unknown>([
      [MentorProfileEntity, profiles],
      [MentorAvailabilitySlotEntity, slots],
      [MentorBookingEntity, bookings],
      [MentorReviewEntity, reviews],
      [PaymentOrderEntity, orders],
    ]);
    const manager = {
      getRepository: jest.fn((entity: EntityTarget<unknown>) => repos.get(entity)),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(async <T>(work: (manager: EntityManager) => Promise<T>) =>
        work(manager),
      ),
    } as unknown as DataSource;
    const checkout = {
      createMentorBookingCheckout: jest.fn().mockResolvedValue({
        orderId: 'mentor-payment-order-1',
        orderCode: 101,
        status: 'PENDING',
        checkoutUrl: 'https://pay.test/mentor-booking',
        qrCode: null,
        paymentLinkId: 'pay-link-1',
        expiresAt: '2026-06-21T00:15:00.000Z',
      }),
    } as unknown as BillingCheckoutService;
    const service = new MentorBookingsService(
      profiles as unknown as Repository<MentorProfileEntity>,
      slots as unknown as Repository<MentorAvailabilitySlotEntity>,
      bookings as unknown as Repository<MentorBookingEntity>,
      reviews as unknown as Repository<MentorReviewEntity>,
      orders as unknown as Repository<PaymentOrderEntity>,
      dataSource,
      checkout,
      () => now,
    );
    return { service, profiles, slots, bookings, reviews, orders, checkout, repos };
  }

  it('holds an open slot with a student goal and creates one full upfront checkout from server-owned mentor pricing', async () => {
    const { service, profiles, slots, bookings, checkout } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.findOne.mockResolvedValue({
      ...openSlot,
      status: 'OPEN',
      heldByBookingId: null,
      holdExpiresAt: null,
    });
    bookings.save.mockImplementation(async (booking) => ({ id: 'booking-1', ...booking }));

    const result = await service.createBooking('student-1', {
      mentorProfileId: 'profile-1',
      slotId: 'slot-1',
      studentGoal: '  Review my backend architecture plan before launch.  ',
    });

    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        studentGoal: 'Review my backend architecture plan before launch.',
        totalAmountVnd: 500000,
        depositAmountVnd: 0,
        remainingAmountVnd: 0,
        paymentOrderId: null,
        status: 'PENDING_PAYMENT',
      }),
    );
    expect(slots.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'HELD',
        heldByBookingId: 'booking-1',
        holdExpiresAt: new Date('2026-06-21T00:15:00.000Z'),
      }),
    );
    expect(checkout.createMentorBookingCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'booking-1', amountVnd: 500000 }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        booking: expect.objectContaining({
          id: 'booking-1',
          status: 'PENDING_PAYMENT',
          studentGoal: 'Review my backend architecture plan before launch.',
        }),
        checkout: expect.objectContaining({ orderCode: 101 }),
      }),
    );
  });

  it('rejects a booking goal that is too short for mentor preparation', async () => {
    const { service } = setup();

    await expect(
      service.createBooking('student-1', {
        mentorProfileId: 'profile-1',
        slotId: 'slot-1',
        studentGoal: 'Too short',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects booking a slot that is not open for the approved mentor profile', async () => {
    const { service, profiles, slots } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.findOne.mockResolvedValue({ ...openSlot, status: 'HELD' });

    await expect(
      service.createBooking('student-1', {
        mentorProfileId: 'profile-1',
        slotId: 'slot-1',
        studentGoal: 'I want to review my project structure and API boundaries.',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a new full checkout for an owned pending-payment booking', async () => {
    const { service, bookings, checkout } = setup();
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      studentId: 'student-1',
      status: 'PENDING_PAYMENT',
      totalAmountVnd: 500000,
      paymentOrderId: null,
      packageSnapshot: { currency: 'VND' },
      createdAt: new Date(),
      updatedAt: null,
    });

    const result = await service.pay('student-1', 'booking-1');

    expect(checkout.createMentorBookingCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'booking-1', amountVnd: 500000 }),
    );
    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({ paymentOrderId: 'mentor-payment-order-1' }),
    );
    expect(result.orderCode).toBe(101);
  });

  it('returns an existing pending full checkout without creating a duplicate order', async () => {
    const { service, bookings, orders, checkout } = setup();
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      studentId: 'student-1',
      status: 'PENDING_PAYMENT',
      totalAmountVnd: 500000,
      paymentOrderId: 'mentor-payment-order-1',
      packageSnapshot: { currency: 'VND' },
      createdAt: new Date(),
      updatedAt: null,
    });
    orders.findOne.mockResolvedValue({
      id: 'mentor-payment-order-1',
      orderCode: '101',
      status: 'PENDING',
      checkoutUrl: 'https://pay.test/mentor-booking',
      qrCode: null,
      paymentLinkId: 'pay-link-1',
      expiresAt: new Date('2026-06-21T00:15:00.000Z'),
    });

    const result = await service.pay('student-1', 'booking-1');

    expect(checkout.createMentorBookingCheckout).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        orderId: 'mentor-payment-order-1',
        orderCode: 101,
        status: 'PENDING',
        checkoutUrl: 'https://pay.test/mentor-booking',
      }),
    );
  });

  it('allows only the booking mentor to set a meeting URL for a confirmed booking', async () => {
    const { service, profiles, bookings } = setup();
    profiles.findOne.mockResolvedValue(profile);
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      mentorId: 'mentor-1',
      status: 'CONFIRMED',
      meetingUrl: null,
      slotStart: openSlot.startsAt,
      slotEnd: openSlot.endsAt,
      createdAt: new Date(),
      updatedAt: null,
    });

    const result = await service.updateMeetingUrl('mentor-1', 'booking-1', {
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
    });

    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }),
    );
    expect(result.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('completes a confirmed booking only after its slot ends', async () => {
    const { service, profiles, bookings } = setup(new Date('2026-06-23T03:01:00.000Z'));
    profiles.findOne.mockResolvedValue(profile);
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      mentorId: 'mentor-1',
      status: 'CONFIRMED',
      slotStart: openSlot.startsAt,
      slotEnd: openSlot.endsAt,
      createdAt: new Date(),
      updatedAt: null,
    });

    const result = await service.completeBooking('mentor-1', 'booking-1');

    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED', completedAt: expect.any(Date) }),
    );
    expect(profiles.save).toHaveBeenCalledWith(expect.objectContaining({ completedSessions: 1 }));
    expect(result.status).toBe('COMPLETED');
  });

  it('creates one review for the owning student after completion and updates mentor rating', async () => {
    const { service, profiles, bookings, reviews } = setup();
    profiles.findOne.mockResolvedValue(profile);
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      studentId: 'student-1',
      mentorProfileId: 'profile-1',
      status: 'COMPLETED',
    });
    reviews.findOne.mockResolvedValue(null);
    reviews.save.mockResolvedValue({
      id: 'review-1',
      bookingId: 'booking-1',
      studentId: 'student-1',
      mentorProfileId: 'profile-1',
      rating: 5,
      comment: 'Very useful session',
      createdAt: new Date('2026-06-24T00:00:00.000Z'),
      updatedAt: null,
    });
    reviews.find.mockResolvedValue([{ rating: 5 }, { rating: 4 }]);

    const result = await service.createReview('student-1', 'booking-1', {
      rating: 5,
      comment: 'Very useful session',
    });

    expect(profiles.save).toHaveBeenCalledWith(
      expect.objectContaining({ ratingAverage: 4.5, reviewCount: 2 }),
    );
    expect(result).toEqual(expect.objectContaining({ id: 'review-1', rating: 5 }));
  });

  it('cancels a confirmed paid booking, reopens its future slot, and queues manual refund review', async () => {
    const { service, bookings, slots } = setup();
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      studentId: 'student-1',
      mentorId: 'mentor-1',
      availabilitySlotId: 'slot-1',
      status: 'CONFIRMED',
      paymentOrderId: 'mentor-payment-order-1',
      slotStart: openSlot.startsAt,
      slotEnd: openSlot.endsAt,
      createdAt: new Date(),
      updatedAt: null,
    });
    slots.findOne.mockResolvedValue({ ...openSlot, status: 'BOOKED' });

    const result = await service.cancelByStudent('student-1', 'booking-1', {
      reason: 'I cannot attend this session',
    });

    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CANCELLED',
        refundStatus: 'PENDING',
        cancellationReason: 'I cannot attend this session',
      }),
    );
    expect(slots.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'OPEN', heldByBookingId: null, holdExpiresAt: null }),
    );
    expect(result.refundStatus).toBe('PENDING');
  });

  it('cancels an unpaid pending booking without queuing a refund', async () => {
    const { service, bookings, slots } = setup();
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      studentId: 'student-1',
      mentorId: 'mentor-1',
      availabilitySlotId: 'slot-1',
      status: 'PENDING_PAYMENT',
      paymentOrderId: null,
      slotStart: openSlot.startsAt,
      slotEnd: openSlot.endsAt,
      createdAt: new Date(),
      updatedAt: null,
    });
    slots.findOne.mockResolvedValue({ ...openSlot, status: 'HELD' });

    const result = await service.cancelByStudent('student-1', 'booking-1', {
      reason: 'I cannot attend this session',
    });

    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CANCELLED',
        refundStatus: 'NOT_REQUIRED',
      }),
    );
    expect(result.refundStatus).toBe('NOT_REQUIRED');
  });

  it('releases slots through the transaction repository when expiring bookings', async () => {
    const { service, bookings, slots, repos } = setup();
    const transactionalSlots = repo<MentorAvailabilitySlotEntity>();
    repos.set(MentorAvailabilitySlotEntity, transactionalSlots);
    const candidate = {
      id: 'booking-payment',
      status: 'PENDING_PAYMENT',
      availabilitySlotId: 'slot-1',
      createdAt: new Date('2026-06-20T23:00:00.000Z'),
      remainingDueAt: null,
    };
    bookings.find.mockResolvedValue([candidate]);
    bookings.findOne.mockResolvedValue(candidate);
    transactionalSlots.findOne.mockResolvedValue({ ...openSlot, id: 'slot-1', status: 'HELD' });

    await service.expireStaleBookings();

    expect(transactionalSlots.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'OPEN', heldByBookingId: null, holdExpiresAt: null }),
    );
    expect(slots.save).not.toHaveBeenCalled();
  });

  it('expires the booking and reopens the slot when full checkout creation fails', async () => {
    const { service, profiles, slots, bookings, checkout } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.findOne.mockResolvedValue({
      ...openSlot,
      status: 'OPEN',
      heldByBookingId: null,
      holdExpiresAt: null,
    });
    bookings.save.mockImplementation(async (booking) => ({ id: 'booking-1', ...booking }));
    (checkout.createMentorBookingCheckout as jest.Mock).mockRejectedValue(
      new Error('payOS unavailable'),
    );
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      status: 'PENDING_PAYMENT',
      availabilitySlotId: 'slot-1',
      refundStatus: 'NOT_REQUIRED',
    });

    await expect(
      service.createBooking('student-1', {
        mentorProfileId: 'profile-1',
        slotId: 'slot-1',
        studentGoal: 'Review my deployment plan and API risk areas before release.',
      }),
    ).rejects.toThrow('payOS unavailable');

    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-1',
        status: 'EXPIRED',
        refundStatus: 'NOT_REQUIRED',
      }),
    );
    expect(slots.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'OPEN', heldByBookingId: null, holdExpiresAt: null }),
    );
  });

  it('expires stale unpaid bookings and releases their slots without refund review', async () => {
    const { service, bookings, slots } = setup();
    const candidates = [
      {
        id: 'booking-payment',
        status: 'PENDING_PAYMENT',
        availabilitySlotId: 'slot-1',
        createdAt: new Date('2026-06-20T23:00:00.000Z'),
        remainingDueAt: null,
      },
    ];
    bookings.find.mockResolvedValue(candidates);
    bookings.findOne.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(candidates.find((booking) => booking.id === where.id)),
    );
    slots.findOne.mockResolvedValueOnce({ ...openSlot, id: 'slot-1', status: 'HELD' });

    const result = await service.expireStaleBookings();

    expect(result).toEqual({ expired: 1 });
    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-payment',
        status: 'EXPIRED',
        refundStatus: 'NOT_REQUIRED',
      }),
    );
    expect(slots.save).toHaveBeenCalledTimes(1);
  });
});
