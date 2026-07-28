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
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
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
const STUDENT_GOAL_MIN_LENGTH = 20;
const STUDENT_GOAL_MAX_LENGTH = 1000;

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
    @InjectRepository(PaymentOrderEntity)
    private readonly orders: Repository<PaymentOrderEntity>,
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
    const studentGoal = this.cleanStudentGoal(dto.studentGoal);
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

      const saved = await bookings.save(
        bookings.create({
          studentId,
          mentorId: profile.userId,
          mentorProfileId: profile.id,
          availabilitySlotId: slot.id,
          planCode: null,
          status: 'PENDING_PAYMENT',
          studentGoal,
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
          depositAmountVnd: 0,
          remainingAmountVnd: 0,
          paymentOrderId: null,
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
      payment = await this.checkout.createMentorBookingCheckout({
        userId: studentId,
        bookingId: booking.id,
        amountVnd: booking.totalAmountVnd,
        currency: String((booking.packageSnapshot as { currency?: string })?.currency ?? 'VND'),
      });
    } catch (error) {
      await this.expireFailedPaymentBooking(booking.id);
      throw error;
    }
    booking.paymentOrderId = payment.orderId;
    await this.bookings.save(booking);
    return { booking: this.toBookingDto(booking), checkout: payment };
  }

  async pay(studentId: string, bookingId: string): Promise<CheckoutResponseDto> {
    const booking = await this.requireBooking(bookingId);
    if (booking.studentId !== studentId)
      throw new ForbiddenException('Booking does not belong to user');
    if (booking.status !== 'PENDING_PAYMENT') {
      throw this.validationError('Booking is not awaiting payment');
    }
    const existing = await this.findReusableCheckout(booking.paymentOrderId);
    if (existing) return existing;

    const payment = await this.checkout.createMentorBookingCheckout({
      userId: studentId,
      bookingId: booking.id,
      amountVnd: booking.totalAmountVnd,
      currency: String((booking.packageSnapshot as { currency?: string })?.currency ?? 'VND'),
    });
    booking.paymentOrderId = payment.orderId;
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
      where: { status: In(['PENDING_PAYMENT', 'AWAITING_REMAINING']) },
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
        const paymentHoldExpired =
          booking.status === 'PENDING_PAYMENT' &&
          booking.createdAt.getTime() + SLOT_HOLD_MS <= now.getTime();
        const remainingExpired =
          booking.status === 'AWAITING_REMAINING' &&
          booking.remainingDueAt !== null &&
          booking.remainingDueAt.getTime() <= now.getTime();
        if (!paymentHoldExpired && !remainingExpired) return false;
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
      // NOTE (bug hunt R4): a time-based "session already happened" block was
      // tried here and reverted — slotEnd-passed does NOT mean delivered (there
      // is no auto-complete and no attendance signal), so it wrongly stranded
      // no-show refunds with no recourse (no dispute flow exists). Cancelling a
      // past CONFIRMED booking sets refundStatus=PENDING, which is a MANUAL
      // review queue — a reviewer approves a genuine no-show and rejects an
      // abusive post-delivery refund. That human gate is the correct control
      // until real completion/attendance tracking exists.
      const requiresRefund = booking.status !== 'PENDING_PAYMENT';
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

  private async expireFailedPaymentBooking(bookingId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const bookings = manager.getRepository(MentorBookingEntity);
      const slots = manager.getRepository(MentorAvailabilitySlotEntity);
      const booking = await bookings.findOne({
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking || booking.status !== 'PENDING_PAYMENT') return;
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
      studentGoal: booking.studentGoal,
      package: booking.packageSnapshot,
      slotStart: booking.slotStart?.toISOString() ?? null,
      slotEnd: booking.slotEnd?.toISOString() ?? null,
      totalAmountVnd: booking.totalAmountVnd,
      depositAmountVnd: booking.depositAmountVnd,
      remainingAmountVnd: booking.remainingAmountVnd,
      paymentOrderId: booking.paymentOrderId,
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

  private cleanStudentGoal(value: string): string {
    const cleaned = value.trim();
    if (cleaned.length < STUDENT_GOAL_MIN_LENGTH || cleaned.length > STUDENT_GOAL_MAX_LENGTH) {
      throw this.validationError(
        `Student goal must be between ${STUDENT_GOAL_MIN_LENGTH} and ${STUDENT_GOAL_MAX_LENGTH} characters`,
      );
    }
    return cleaned;
  }

  private async findReusableCheckout(orderId: string | null): Promise<CheckoutResponseDto | null> {
    if (!orderId) return null;
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order || !['PENDING', 'PAID'].includes(order.status)) return null;
    return this.toCheckoutDto(order);
  }

  private toCheckoutDto(order: PaymentOrderEntity): CheckoutResponseDto {
    return {
      orderId: order.id,
      orderCode: Number(order.orderCode),
      status: order.status,
      checkoutUrl: order.checkoutUrl,
      qrCode: order.qrCode,
      paymentLinkId: order.paymentLinkId,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      pricing: {
        originalAmountVnd: order.originalAmountVnd ?? order.amountVnd,
        discountPercent: order.discountPercent ?? 0,
        discountAmountVnd: order.discountAmountVnd ?? 0,
        finalAmountVnd: order.amountVnd,
        voucherCode: order.voucherCode ?? null,
        currency: order.currency,
      },
    };
  }
}

function cleanNullableString(value: string | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}
