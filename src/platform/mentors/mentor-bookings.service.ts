import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { MentorAvailabilitySlotEntity } from '../../database/entities/mentor-availability-slot.entity';
import { MentorBookingEntity } from '../../database/entities/mentor-booking.entity';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import { MentorReviewEntity } from '../../database/entities/mentor-review.entity';
import { CheckoutResponseDto } from '../billing/dto/billing.dto';
import { BillingCheckoutService } from '../billing/services/billing-checkout.service';
import {
  CancelMentorBookingDto,
  CreateMentorBookingDto,
  CreateMentorReviewDto,
  UpdateMeetingUrlDto,
} from './dto/mentor-booking.dto';

export const MENTOR_BOOKING_CLOCK = Symbol('MENTOR_BOOKING_CLOCK');
const SLOT_HOLD_MS = 15 * 60 * 1000;
const REMAINING_PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_PAYMENT_BUFFER_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class MentorBookingsService {
  constructor(
    @InjectRepository(MentorProfileEntity)
    private readonly profiles: Repository<MentorProfileEntity>,
    @InjectRepository(MentorAvailabilitySlotEntity)
    private readonly slots: Repository<MentorAvailabilitySlotEntity>,
    @InjectRepository(MentorBookingEntity)
    private readonly bookings: Repository<MentorBookingEntity>,
    @InjectRepository(MentorReviewEntity)
    private readonly reviews: Repository<MentorReviewEntity>,
    private readonly dataSource: DataSource,
    private readonly checkout: BillingCheckoutService,
    @Optional() @Inject(MENTOR_BOOKING_CLOCK) private readonly clock?: () => Date,
  ) {}

  async createBooking(
    studentId: string,
    dto: CreateMentorBookingDto,
  ): Promise<{
    booking: ReturnType<MentorBookingsService['toBookingDto']>;
    checkout: CheckoutResponseDto;
  }> {
    const now = this.now();
    await this.expireStaleBookings();
    const booking = await this.dataSource.transaction(async (manager) => {
      const profiles = manager.getRepository(MentorProfileEntity);
      const slots = manager.getRepository(MentorAvailabilitySlotEntity);
      const bookings = manager.getRepository(MentorBookingEntity);
      const profile = await profiles.findOne({ where: { id: dto.mentorProfileId } });
      if (!profile || profile.status !== 'APPROVED' || !profile.isAcceptingBookings) {
        throw new NotFoundException('Bookable mentor profile not found');
      }
      if (profile.userId === studentId)
        throw this.validationError('Mentors cannot book themselves');

      const slot = await slots.findOne({
        where: { id: dto.slotId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !slot ||
        slot.mentorProfileId !== profile.id ||
        slot.status !== 'OPEN' ||
        slot.startsAt.getTime() <= now.getTime()
      ) {
        throw this.validationError('Mentor slot is not available');
      }

      const depositAmountVnd = Math.round(profile.sessionPriceVnd * 0.1);
      const saved = await bookings.save(
        bookings.create({
          studentId,
          mentorId: profile.userId,
          mentorProfileId: profile.id,
          availabilitySlotId: slot.id,
          planCode: null,
          status: 'PENDING_DEPOSIT',
          packageSnapshot: {
            mentorProfileId: profile.id,
            mentorSlug: profile.slug,
            headline: profile.headline,
            sessionPriceVnd: profile.sessionPriceVnd,
            sessionDurationMinutes: profile.sessionDurationMinutes,
            currency: profile.currency,
          },
          slotStart: slot.startsAt,
          slotEnd: slot.endsAt,
          totalAmountVnd: profile.sessionPriceVnd,
          depositAmountVnd,
          remainingAmountVnd: profile.sessionPriceVnd - depositAmountVnd,
          depositPaymentOrderId: null,
          remainingPaymentOrderId: null,
          acceptedAt: null,
          remainingDueAt: null,
          meetingUrl: null,
          completedAt: null,
          cancelledAt: null,
          cancelledBy: null,
          cancellationReason: null,
          refundStatus: 'NOT_REQUIRED',
          refundNote: null,
        }),
      );
      slot.status = 'HELD';
      slot.heldByBookingId = saved.id;
      slot.holdExpiresAt = new Date(now.getTime() + SLOT_HOLD_MS);
      await slots.save(slot);
      return saved;
    });

    let payment: CheckoutResponseDto;
    try {
      payment = await this.checkout.createMentorDepositCheckout({
        userId: studentId,
        bookingId: booking.id,
        amountVnd: booking.depositAmountVnd,
        currency: String((booking.packageSnapshot as { currency?: string })?.currency ?? 'VND'),
      });
    } catch (error) {
      await this.expireFailedDepositBooking(booking.id);
      throw error;
    }
    booking.depositPaymentOrderId = payment.orderId;
    await this.bookings.save(booking);
    return { booking: this.toBookingDto(booking), checkout: payment };
  }

  async payRemaining(studentId: string, bookingId: string): Promise<CheckoutResponseDto> {
    const booking = await this.requireBooking(bookingId);
    if (booking.studentId !== studentId)
      throw new ForbiddenException('Booking does not belong to user');
    if (booking.status !== 'AWAITING_REMAINING') {
      throw this.validationError('Booking is not awaiting remaining payment');
    }
    if (booking.remainingDueAt && booking.remainingDueAt.getTime() <= this.now().getTime()) {
      throw this.validationError('Remaining payment deadline has passed');
    }
    if (booking.remainingPaymentOrderId)
      throw new ConflictException('Remaining payment already created');
    const payment = await this.checkout.createMentorRemainingCheckout({
      userId: studentId,
      bookingId: booking.id,
      amountVnd: booking.remainingAmountVnd,
      currency: String((booking.packageSnapshot as { currency?: string })?.currency ?? 'VND'),
    });
    booking.remainingPaymentOrderId = payment.orderId;
    await this.bookings.save(booking);
    return payment;
  }

  async listStudentBookings(studentId: string) {
    const items = await this.bookings.find({ where: { studentId }, order: { createdAt: 'DESC' } });
    return items.map((booking) => this.toBookingDto(booking));
  }

  async getStudentBooking(studentId: string, bookingId: string) {
    const booking = await this.requireBooking(bookingId);
    if (booking.studentId !== studentId) throw new NotFoundException('Mentor booking not found');
    return this.toBookingDto(booking);
  }

  async listMentorBookings(mentorUserId: string) {
    await this.requireMentorProfile(mentorUserId);
    const items = await this.bookings.find({
      where: { mentorId: mentorUserId },
      order: { slotStart: 'DESC' },
    });
    return items.map((booking) => this.toBookingDto(booking));
  }

  async updateMeetingUrl(mentorUserId: string, bookingId: string, dto: UpdateMeetingUrlDto) {
    await this.requireMentorProfile(mentorUserId);
    const booking = await this.requireMentorBooking(mentorUserId, bookingId);
    if (booking.status !== 'CONFIRMED') {
      throw this.validationError('Meeting URL can only be set for confirmed bookings');
    }
    booking.meetingUrl = dto.meetingUrl.trim();
    return this.toBookingDto(await this.bookings.save(booking));
  }

  async completeBooking(mentorUserId: string, bookingId: string) {
    return this.dataSource.transaction(async (manager) => {
      const bookings = manager.getRepository(MentorBookingEntity);
      const profiles = manager.getRepository(MentorProfileEntity);
      const profile = await profiles.findOne({
        where: { userId: mentorUserId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!profile) throw new NotFoundException('Mentor profile not found');
      const booking = await bookings.findOne({
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking || booking.mentorId !== mentorUserId) {
        throw new NotFoundException('Mentor booking not found');
      }
      if (booking.status !== 'CONFIRMED') throw this.validationError('Booking is not confirmed');
      if (!booking.slotEnd || booking.slotEnd.getTime() > this.now().getTime()) {
        throw this.validationError('Booking cannot be completed before the session ends');
      }
      booking.status = 'COMPLETED';
      booking.completedAt = this.now();
      profile.completedSessions += 1;
      await profiles.save(profile);
      return this.toBookingDto(await bookings.save(booking));
    });
  }

  async cancelByStudent(studentId: string, bookingId: string, dto: CancelMentorBookingDto) {
    return this.cancelLockedBooking(
      bookingId,
      studentId,
      dto.reason,
      (booking) => booking.studentId === studentId,
    );
  }

  async cancelByMentor(mentorUserId: string, bookingId: string, dto: CancelMentorBookingDto) {
    await this.requireMentorProfile(mentorUserId);
    return this.cancelLockedBooking(
      bookingId,
      mentorUserId,
      dto.reason,
      (booking) => booking.mentorId === mentorUserId,
    );
  }

  async createReview(studentId: string, bookingId: string, dto: CreateMentorReviewDto) {
    return this.dataSource.transaction(async (manager) => {
      const bookings = manager.getRepository(MentorBookingEntity);
      const reviews = manager.getRepository(MentorReviewEntity);
      const profiles = manager.getRepository(MentorProfileEntity);
      const booking = await bookings.findOne({
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking || booking.studentId !== studentId) {
        throw new NotFoundException('Mentor booking not found');
      }
      if (booking.status !== 'COMPLETED')
        throw this.validationError('Only completed bookings can be reviewed');
      if (await reviews.findOne({ where: { bookingId } })) {
        throw new ConflictException('Booking has already been reviewed');
      }
      const profile = await profiles.findOne({
        where: { id: booking.mentorProfileId },
        lock: { mode: 'pessimistic_write' },
      });
      const review = await reviews.save(
        reviews.create({
          bookingId,
          studentId,
          mentorProfileId: booking.mentorProfileId,
          rating: dto.rating,
          comment: cleanNullableString(dto.comment),
        }),
      );
      if (profile) {
        const allReviews = await reviews.find({ where: { mentorProfileId: profile.id } });
        profile.reviewCount = allReviews.length;
        profile.ratingAverage =
          allReviews.length === 0
            ? null
            : Math.round(
                (allReviews.reduce((sum, item) => sum + item.rating, 0) / allReviews.length) * 10,
              ) / 10;
        await profiles.save(profile);
      }
      return {
        id: review.id,
        bookingId: review.bookingId,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
      };
    });
  }

  async expireStaleBookings(): Promise<{ expired: number }> {
    const now = this.now();
    const candidates = await this.bookings.find({
      where: { status: In(['PENDING_DEPOSIT', 'AWAITING_REMAINING']) },
    });
    let expired = 0;
    for (const candidate of candidates) {
      const didExpire = await this.dataSource.transaction(async (manager) => {
        const bookings = manager.getRepository(MentorBookingEntity);
        const slots = manager.getRepository(MentorAvailabilitySlotEntity);
        const booking = await bookings.findOne({
          where: { id: candidate.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!booking) return false;
        const depositHoldExpired =
          booking.status === 'PENDING_DEPOSIT' &&
          booking.createdAt.getTime() + SLOT_HOLD_MS <= now.getTime();
        const remainingExpired =
          booking.status === 'AWAITING_REMAINING' &&
          booking.remainingDueAt !== null &&
          booking.remainingDueAt.getTime() <= now.getTime();
        if (!depositHoldExpired && !remainingExpired) return false;
        const requiresRefund = booking.status === 'AWAITING_REMAINING';
        booking.status = 'EXPIRED';
        booking.refundStatus = requiresRefund ? 'PENDING' : 'NOT_REQUIRED';
        await this.releaseFutureSlotWith(slots, booking);
        await bookings.save(booking);
        return true;
      });
      if (didExpire) expired += 1;
    }
    return { expired };
  }

  remainingDueAt(paidAt: Date, slotStart: Date): Date {
    return new Date(
      Math.min(
        paidAt.getTime() + REMAINING_PAYMENT_WINDOW_MS,
        slotStart.getTime() - SESSION_PAYMENT_BUFFER_MS,
      ),
    );
  }

  private async cancelLockedBooking(
    bookingId: string,
    actorId: string,
    reason: string,
    ownsBooking: (booking: MentorBookingEntity) => boolean,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const bookings = manager.getRepository(MentorBookingEntity);
      const slots = manager.getRepository(MentorAvailabilitySlotEntity);
      const booking = await bookings.findOne({
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking || !ownsBooking(booking))
        throw new NotFoundException('Mentor booking not found');
      if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(booking.status)) {
        throw this.validationError('Booking cannot be cancelled in its current status');
      }
      const requiresRefund = booking.status !== 'PENDING_DEPOSIT';
      booking.status = 'CANCELLED';
      booking.cancelledAt = this.now();
      booking.cancelledBy = actorId;
      booking.cancellationReason = reason.trim();
      booking.refundStatus = requiresRefund ? 'PENDING' : 'NOT_REQUIRED';
      await this.releaseFutureSlotWith(slots, booking);
      return this.toBookingDto(await bookings.save(booking));
    });
  }

  private async releaseFutureSlotWith(
    slots: Repository<MentorAvailabilitySlotEntity>,
    booking: MentorBookingEntity,
  ): Promise<void> {
    const slot = await slots.findOne({
      where: { id: booking.availabilitySlotId },
      lock: { mode: 'pessimistic_write' },
    });
    if (slot && slot.startsAt.getTime() > this.now().getTime()) {
      slot.status = 'OPEN';
      slot.heldByBookingId = null;
      slot.holdExpiresAt = null;
      await slots.save(slot);
    }
  }

  private async expireFailedDepositBooking(bookingId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const bookings = manager.getRepository(MentorBookingEntity);
      const slots = manager.getRepository(MentorAvailabilitySlotEntity);
      const booking = await bookings.findOne({
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking || booking.status !== 'PENDING_DEPOSIT') return;
      booking.status = 'EXPIRED';
      booking.refundStatus = 'NOT_REQUIRED';
      await this.releaseFutureSlotWith(slots, booking);
      await bookings.save(booking);
    });
  }

  private async requireBooking(id: string): Promise<MentorBookingEntity> {
    const booking = await this.bookings.findOne({ where: { id } });
    if (!booking) throw new NotFoundException('Mentor booking not found');
    return booking;
  }

  private async requireMentorProfile(userId: string): Promise<MentorProfileEntity> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) throw new NotFoundException('Mentor profile not found');
    return profile;
  }

  private async requireMentorBooking(
    userId: string,
    bookingId: string,
  ): Promise<MentorBookingEntity> {
    const booking = await this.requireBooking(bookingId);
    if (booking.mentorId !== userId) throw new NotFoundException('Mentor booking not found');
    return booking;
  }

  private toBookingDto(booking: MentorBookingEntity) {
    return {
      id: booking.id,
      studentId: booking.studentId,
      mentorProfileId: booking.mentorProfileId,
      availabilitySlotId: booking.availabilitySlotId,
      status: booking.status,
      package: booking.packageSnapshot,
      slotStart: booking.slotStart?.toISOString() ?? null,
      slotEnd: booking.slotEnd?.toISOString() ?? null,
      totalAmountVnd: booking.totalAmountVnd,
      depositAmountVnd: booking.depositAmountVnd,
      remainingAmountVnd: booking.remainingAmountVnd,
      remainingDueAt: booking.remainingDueAt?.toISOString() ?? null,
      meetingUrl: booking.meetingUrl,
      refundStatus: booking.refundStatus,
      cancellationReason: booking.cancellationReason,
      completedAt: booking.completedAt?.toISOString() ?? null,
      createdAt: booking.createdAt?.toISOString?.() ?? null,
      updatedAt: booking.updatedAt?.toISOString?.() ?? null,
    };
  }

  private validationError(message: string): BadRequestException {
    return new BadRequestException({ errorCode: ERROR_CODES.VALIDATION_ERROR, message });
  }

  private now(): Date {
    return this.clock?.() ?? new Date();
  }
}

function cleanNullableString(value: string | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}
