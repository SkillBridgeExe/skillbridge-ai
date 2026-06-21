import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ERROR_CODES } from '../../../common/constants/error-codes';
import { BillingPlanEntity } from '../../../database/entities/billing-plan.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { CheckoutResponseDto, CreateCheckoutDto } from '../dto/billing.dto';
import { generatePayosOrderCode } from '../order-code.util';
import { PaymentProviderRegistry } from '../payment-providers/payment-provider.registry';

@Injectable()
export class BillingCheckoutService {
  constructor(
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    @InjectRepository(PaymentOrderEntity) private readonly orders: Repository<PaymentOrderEntity>,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  async createCheckout(userId: string, dto: CreateCheckoutDto): Promise<CheckoutResponseDto> {
    switch (dto.purpose) {
      case 'SUBSCRIPTION':
        return this.createSubscriptionCheckout(userId, dto);
      default:
        throw new BadRequestException({
          errorCode: ERROR_CODES.VALIDATION_ERROR,
          message: 'Mentor payments must be created through the mentor booking API',
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

  async createMentorDepositCheckout(
    input: MentorPaymentCheckoutInput,
  ): Promise<CheckoutResponseDto> {
    const order = await this.createPendingOrder({
      userId: input.userId,
      amountVnd: input.amountVnd,
      purpose: 'MENTOR_DEPOSIT',
      targetType: 'MENTOR_BOOKING',
      targetId: input.bookingId,
      planCode: null,
      currency: input.currency,
    });
    return this.createProviderLink(order, 'Mentor session deposit');
  }

  async createMentorRemainingCheckout(
    input: MentorPaymentCheckoutInput,
  ): Promise<CheckoutResponseDto> {
    const order = await this.createPendingOrder({
      userId: input.userId,
      amountVnd: input.amountVnd,
      purpose: 'MENTOR_REMAINING',
      targetType: 'MENTOR_BOOKING',
      targetId: input.bookingId,
      planCode: null,
      currency: input.currency,
    });
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

  private async createPendingOrder(input: {
    userId: string;
    amountVnd: number;
    purpose: PaymentOrderEntity['purpose'];
    targetType: PaymentOrderEntity['targetType'];
    targetId: string | null;
    planCode: string | null;
    currency?: string;
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
          currency: input.currency ?? 'VND',
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
    const link = await provider
      .createPaymentLink({
        orderCode: Number(order.orderCode),
        amountVnd: order.amountVnd,
        description: order.description,
        itemName,
      })
      .catch(async (error) => {
        order.status = 'FAILED';
        await this.orders.save(order);
        throw error;
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

export interface MentorPaymentCheckoutInput {
  userId: string;
  bookingId: string;
  amountVnd: number;
  currency: string;
}
