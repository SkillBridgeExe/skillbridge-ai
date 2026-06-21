import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget, Repository } from 'typeorm';
import { MentorAvailabilitySlotEntity } from '../../database/entities/mentor-availability-slot.entity';
import { MentorBookingEntity } from '../../database/entities/mentor-booking.entity';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import { MentorReviewEntity } from '../../database/entities/mentor-review.entity';
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
    const repos = new Map<EntityTarget<unknown>, unknown>([
      [MentorProfileEntity, profiles],
      [MentorAvailabilitySlotEntity, slots],
      [MentorBookingEntity, bookings],
      [MentorReviewEntity, reviews],
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
      createMentorDepositCheckout: jest.fn().mockResolvedValue({
        orderId: 'deposit-order-1',
        orderCode: 101,
        status: 'PENDING',
        checkoutUrl: 'https://pay.test/deposit',
        qrCode: null,
        paymentLinkId: 'pay-link-1',
        expiresAt: '2026-06-21T00:15:00.000Z',
      }),
      createMentorRemainingCheckout: jest.fn().mockResolvedValue({
        orderId: 'remaining-order-1',
        orderCode: 102,
        status: 'PENDING',
        checkoutUrl: 'https://pay.test/remaining',
        qrCode: null,
        paymentLinkId: 'pay-link-2',
        expiresAt: null,
      }),
    } as unknown as BillingCheckoutService;
    const service = new MentorBookingsService(
      profiles as unknown as Repository<MentorProfileEntity>,
      slots as unknown as Repository<MentorAvailabilitySlotEntity>,
      bookings as unknown as Repository<MentorBookingEntity>,
      reviews as unknown as Repository<MentorReviewEntity>,
      dataSource,
      checkout,
      () => now,
    );
    return { service, profiles, slots, bookings, reviews, checkout, repos };
  }

  it('holds an open slot and creates a 10 percent deposit from server-owned mentor pricing', async () => {
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
    });

    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        totalAmountVnd: 500000,
        depositAmountVnd: 50000,
        remainingAmountVnd: 450000,
        status: 'PENDING_DEPOSIT',
      }),
    );
    expect(slots.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'HELD',
        heldByBookingId: 'booking-1',
        holdExpiresAt: new Date('2026-06-21T00:15:00.000Z'),
      }),
    );
    expect(checkout.createMentorDepositCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'booking-1', amountVnd: 50000 }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        booking: expect.objectContaining({ id: 'booking-1', status: 'PENDING_DEPOSIT' }),
        checkout: expect.objectContaining({ orderCode: 101 }),
      }),
    );
  });

  it('rejects booking a slot that is not open for the approved mentor profile', async () => {
    const { service, profiles, slots } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.findOne.mockResolvedValue({ ...openSlot, status: 'HELD' });

    await expect(
      service.createBooking('student-1', { mentorProfileId: 'profile-1', slotId: 'slot-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets only the owning student create the remaining payment checkout', async () => {
    const { service, bookings, checkout } = setup();
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      studentId: 'student-1',
      status: 'AWAITING_REMAINING',
      remainingAmountVnd: 450000,
      remainingPaymentOrderId: null,
      remainingDueAt: new Date('2026-06-22T00:00:00.000Z'),
    });

    await expect(service.payRemaining('other-user', 'booking-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const result = await service.payRemaining('student-1', 'booking-1');

    expect(checkout.createMentorRemainingCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'booking-1', amountVnd: 450000 }),
    );
    expect(result.orderCode).toBe(102);
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

  it('cancels a deposited booking, reopens its future slot, and queues manual refund review', async () => {
    const { service, bookings, slots } = setup();
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      studentId: 'student-1',
      mentorId: 'mentor-1',
      availabilitySlotId: 'slot-1',
      status: 'AWAITING_REMAINING',
      depositPaymentOrderId: 'deposit-order-1',
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

  it('releases slots through the transaction repository when expiring bookings', async () => {
    const { service, bookings, slots, repos } = setup();
    const transactionalSlots = repo<MentorAvailabilitySlotEntity>();
    repos.set(MentorAvailabilitySlotEntity, transactionalSlots);
    const candidate = {
      id: 'booking-deposit',
      status: 'PENDING_DEPOSIT',
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

  it('expires the booking and reopens the slot when deposit checkout creation fails', async () => {
    const { service, profiles, slots, bookings, checkout } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.findOne.mockResolvedValue({
      ...openSlot,
      status: 'OPEN',
      heldByBookingId: null,
      holdExpiresAt: null,
    });
    bookings.save.mockImplementation(async (booking) => ({ id: 'booking-1', ...booking }));
    (checkout.createMentorDepositCheckout as jest.Mock).mockRejectedValue(
      new Error('payOS unavailable'),
    );
    bookings.findOne.mockResolvedValue({
      id: 'booking-1',
      status: 'PENDING_DEPOSIT',
      availabilitySlotId: 'slot-1',
      refundStatus: 'NOT_REQUIRED',
    });

    await expect(
      service.createBooking('student-1', {
        mentorProfileId: 'profile-1',
        slotId: 'slot-1',
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

  it('expires stale deposit and remaining-payment bookings and releases their slots', async () => {
    const { service, bookings, slots } = setup();
    const candidates = [
      {
        id: 'booking-deposit',
        status: 'PENDING_DEPOSIT',
        availabilitySlotId: 'slot-1',
        createdAt: new Date('2026-06-20T23:00:00.000Z'),
        remainingDueAt: null,
      },
      {
        id: 'booking-remaining',
        status: 'AWAITING_REMAINING',
        availabilitySlotId: 'slot-2',
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
        remainingDueAt: new Date('2026-06-20T23:59:00.000Z'),
      },
    ];
    bookings.find.mockResolvedValue(candidates);
    bookings.findOne.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(candidates.find((booking) => booking.id === where.id)),
    );
    slots.findOne
      .mockResolvedValueOnce({ ...openSlot, id: 'slot-1', status: 'HELD' })
      .mockResolvedValueOnce({ ...openSlot, id: 'slot-2', status: 'BOOKED' });

    const result = await service.expireStaleBookings();

    expect(result).toEqual({ expired: 2 });
    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-deposit',
        status: 'EXPIRED',
        refundStatus: 'NOT_REQUIRED',
      }),
    );
    expect(bookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-remaining',
        status: 'EXPIRED',
        refundStatus: 'PENDING',
      }),
    );
    expect(slots.save).toHaveBeenCalledTimes(2);
  });
});
