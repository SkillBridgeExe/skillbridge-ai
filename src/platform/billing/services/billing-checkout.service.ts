import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ERROR_CODES } from '../../../common/constants/error-codes';
import { BillingPlanEntity } from '../../../database/entities/billing-plan.entity';
import { MentorBookingEntity } from '../../../database/entities/mentor-booking.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { UserEntity } from '../../../database/entities/user.entity';
import { CheckoutResponseDto, CreateCheckoutDto } from '../dto/billing.dto';
import { generatePayosOrderCode } from '../order-code.util';
import { PaymentProviderRegistry } from '../payment-providers/payment-provider.registry';

@Injectable()
export class BillingCheckoutService {
  constructor(
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    @InjectRepository(PaymentOrderEntity) private readonly orders: Repository<PaymentOrderEntity>,
    @InjectRepository(MentorBookingEntity)
    private readonly mentorBookings: Repository<MentorBookingEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  async createCheckout(userId: string, dto: CreateCheckoutDto): Promise<CheckoutResponseDto> {
    switch (dto.purpose) {
      case 'SUBSCRIPTION':
        return this.createSubscriptionCheckout(userId, dto);
      case 'MENTOR_DEPOSIT':
        return this.createMentorDepositCheckout(userId, dto);
      case 'MENTOR_REMAINING':
        return this.createMentorRemainingCheckout(userId, dto);
      default:
        throw new BadRequestException({
          errorCode: ERROR_CODES.VALIDATION_ERROR,
          message: 'Unsupported checkout purpose',
        });
    }
  }

  private async createSubscriptionCheckout(
    userId: string,
    dto: CreateCheckoutDto,
  ): Promise<CheckoutResponseDto> {
    const plan = await this.requirePlan(dto.planCode, 'SUBSCRIPTION');
    if (plan.priceVnd <= 0) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Free plan does not require checkout',
      });
    }
    const order = await this.createPendingOrder({
      userId,
      amountVnd: plan.priceVnd,
      purpose: 'SUBSCRIPTION',
      targetType: 'SUBSCRIPTION',
      targetId: null,
      planCode: plan.code,
    });
    return this.createProviderLink(order, plan.name);
  }

  private async createMentorDepositCheckout(
    userId: string,
    dto: CreateCheckoutDto,
  ): Promise<CheckoutResponseDto> {
    const plan = await this.requirePlan(dto.planCode, 'MENTOR_PACKAGE');
    if (!dto.mentorId) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'mentorId is required for mentor deposit checkout',
      });
    }
    await this.requireUser(dto.mentorId);
    const depositAmount = Math.round(plan.priceVnd * 0.1);
    const booking = await this.mentorBookings.save(
      this.mentorBookings.create({
        studentId: userId,
        mentorId: dto.mentorId,
        planCode: plan.code,
        status: 'PENDING_DEPOSIT',
        packageSnapshot: {
          planCode: plan.code,
          name: plan.name,
          priceVnd: plan.priceVnd,
          currency: plan.currency,
        },
        slotStart: dto.slotStart ? new Date(dto.slotStart) : null,
        slotEnd: dto.slotEnd ? new Date(dto.slotEnd) : null,
        totalAmountVnd: plan.priceVnd,
        depositAmountVnd: depositAmount,
        remainingAmountVnd: plan.priceVnd - depositAmount,
      }),
    );
    const order = await this.createPendingOrder({
      userId,
      amountVnd: depositAmount,
      purpose: 'MENTOR_DEPOSIT',
      targetType: 'MENTOR_BOOKING',
      targetId: booking.id,
      planCode: plan.code,
    });
    booking.depositPaymentOrderId = order.id;
    await this.mentorBookings.save(booking);
    return this.createProviderLink(order, `${plan.name} deposit`);
  }

  private async createMentorRemainingCheckout(
    userId: string,
    dto: CreateCheckoutDto,
  ): Promise<CheckoutResponseDto> {
    if (!dto.bookingId) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'bookingId is required for mentor remaining checkout',
      });
    }
    const booking = await this.mentorBookings.findOne({
      where: { id: dto.bookingId, studentId: userId },
    });
    if (!booking) throw new NotFoundException('Mentor booking not found');
    if (!['AWAITING_MENTOR_ACCEPT', 'AWAITING_REMAINING'].includes(booking.status)) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Booking is not ready for remaining payment',
      });
    }
    const order = await this.createPendingOrder({
      userId,
      amountVnd: booking.remainingAmountVnd,
      purpose: 'MENTOR_REMAINING',
      targetType: 'MENTOR_BOOKING',
      targetId: booking.id,
      planCode: booking.planCode,
    });
    booking.remainingPaymentOrderId = order.id;
    await this.mentorBookings.save(booking);
    return this.createProviderLink(order, 'Mentor remaining');
  }

  private async requirePlan(
    planCode: string | undefined,
    category: BillingPlanEntity['category'],
  ): Promise<BillingPlanEntity> {
    if (!planCode) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'planCode is required',
      });
    }
    const plan = await this.plans.findOne({ where: { code: planCode, category, isActive: true } });
    if (!plan) throw new NotFoundException('Billing plan not found');
    return plan;
  }

  private async requireUser(userId: string): Promise<UserEntity> {
    const user = await this.users.findOne({ where: { id: userId, isActive: true } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async createPendingOrder(input: {
    userId: string;
    amountVnd: number;
    purpose: PaymentOrderEntity['purpose'];
    targetType: PaymentOrderEntity['targetType'];
    targetId: string | null;
    planCode: string | null;
  }): Promise<PaymentOrderEntity> {
    const provider = this.providers.activeProviderCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const orderCode = generatePayosOrderCode();
      const exists = await this.orders.exist({ where: { orderCode: String(orderCode) } });
      if (exists) continue;
      return this.orders.save(
        this.orders.create({
          ...input,
          provider,
          orderCode: String(orderCode),
          currency: 'VND',
          status: 'PENDING',
          description: `SB${orderCode}`,
        }),
      );
    }
    throw new BadRequestException('Could not generate unique payment orderCode');
  }

  private async createProviderLink(
    order: PaymentOrderEntity,
    itemName: string,
  ): Promise<CheckoutResponseDto> {
    const provider = this.providers.get(order.provider);
    const link = await provider.createPaymentLink({
      orderCode: Number(order.orderCode),
      amountVnd: order.amountVnd,
      description: order.description,
      itemName,
    });
    order.checkoutUrl = link.checkoutUrl;
    order.paymentLinkId = link.paymentLinkId;
    order.qrCode = link.qrCode;
    order.providerPayload = link.providerPayload;
    order.expiresAt = link.expiresAt;
    const saved = await this.orders.save(order);
    return {
      orderId: saved.id,
      orderCode: Number(saved.orderCode),
      status: saved.status,
      checkoutUrl: saved.checkoutUrl,
      qrCode: saved.qrCode,
      paymentLinkId: saved.paymentLinkId,
      expiresAt: saved.expiresAt?.toISOString() ?? null,
    };
  }
}
