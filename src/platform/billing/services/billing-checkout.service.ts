import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ERROR_CODES } from '../../../common/constants/error-codes';
import { BillingPlanEntity } from '../../../database/entities/billing-plan.entity';
import {
  BillingCreditPackageEntity,
  CreditType,
} from '../../../database/entities/billing-credit-package.entity';
import { PaymentOrderEntity } from '../../../database/entities/payment-order.entity';
import { CheckoutResponseDto, CreateCheckoutDto } from '../dto/billing.dto';
import { generatePayosOrderCode } from '../order-code.util';
import { PaymentProviderRegistry } from '../payment-providers/payment-provider.registry';
import { VoucherService } from '../voucher.service';

const CHECKOUT_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class BillingCheckoutService {
  private readonly logger = new Logger(BillingCheckoutService.name);

  constructor(
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    @InjectRepository(BillingCreditPackageEntity)
    private readonly creditPackages: Repository<BillingCreditPackageEntity>,
    @InjectRepository(PaymentOrderEntity) private readonly orders: Repository<PaymentOrderEntity>,
    private readonly providers: PaymentProviderRegistry,
    private readonly vouchers: VoucherService,
  ) {}

  async createCheckout(
    userId: string,
    dto: CreateCheckoutDto,
    checkoutOrigin?: string,
  ): Promise<CheckoutResponseDto> {
    switch (dto.purpose) {
      case 'SUBSCRIPTION':
        return this.createSubscriptionCheckout(userId, dto, checkoutOrigin);
      case 'CREDIT_PACKAGE':
        return this.createCreditPackageCheckout(userId, dto, checkoutOrigin);
      default:
        throw new BadRequestException({
          errorCode: ERROR_CODES.VALIDATION_ERROR,
          message: 'Mentor payments must be created through the mentor booking API',
        });
    }
  }

  private async createCreditPackageCheckout(
    userId: string,
    dto: CreateCheckoutDto,
    checkoutOrigin?: string,
  ): Promise<CheckoutResponseDto> {
    if (dto.voucherCode) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Vouchers cannot be applied to credit packages',
      });
    }
    if (!dto.planCode) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'planCode is required',
      });
    }
    // Load the package and its editable commercial fields in one statement so a concurrent admin
    // update cannot produce a mixed snapshot (for example, old price with new units).
    const creditPackage = await this.creditPackages.findOne({
      where: { planCode: dto.planCode },
      relations: { plan: true },
    });
    const plan = creditPackage?.plan;
    if (
      !creditPackage ||
      !plan ||
      plan.category !== 'CREDIT_PACKAGE' ||
      plan.interval !== 'ONE_TIME' ||
      !plan.isActive ||
      plan.priceVnd <= 0
    ) {
      throw new NotFoundException('Credit package not found');
    }
    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);
    const order = await this.createPendingOrder({
      userId,
      amountVnd: plan.priceVnd,
      originalAmountVnd: plan.priceVnd,
      discountPercent: 0,
      discountAmountVnd: 0,
      voucherId: null,
      voucherCode: null,
      purpose: 'CREDIT_PACKAGE',
      targetType: 'CREDIT_PACKAGE',
      targetId: creditPackage.id,
      planCode: plan.code,
      creditType: creditPackage.creditType,
      creditUnits: creditPackage.units,
      currency: plan.currency,
      expiresAt,
    });
    return this.createProviderLink(order, plan.name, expiresAt, checkoutOrigin);
  }

  private async createSubscriptionCheckout(
    userId: string,
    dto: CreateCheckoutDto,
    checkoutOrigin?: string,
  ): Promise<CheckoutResponseDto> {
    const plan = await this.requirePlan(dto.planCode, 'SUBSCRIPTION');
    if (plan.priceVnd <= 0) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Free plan does not require checkout',
      });
    }
    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);
    const reservation = dto.voucherCode
      ? await this.vouchers.reserve(
          userId,
          { planCode: plan.code, voucherCode: dto.voucherCode },
          expiresAt,
        )
      : null;
    try {
      const order = await this.createPendingOrder({
        userId,
        amountVnd: reservation?.finalAmountVnd ?? plan.priceVnd,
        originalAmountVnd: reservation?.originalAmountVnd ?? plan.priceVnd,
        discountPercent: reservation?.discountPercent ?? 0,
        discountAmountVnd: reservation?.discountAmountVnd ?? 0,
        voucherId: reservation?.voucherId ?? null,
        voucherCode: reservation?.voucherCode ?? null,
        purpose: 'SUBSCRIPTION',
        targetType: 'SUBSCRIPTION',
        targetId: null,
        planCode: plan.code,
        expiresAt,
      });
      if (reservation) await this.vouchers.attachOrder(reservation.redemptionId, order.id);
      return await this.createProviderLink(order, plan.name, expiresAt, checkoutOrigin);
    } catch (error) {
      if (reservation) await this.vouchers.releaseReservation(reservation.redemptionId);
      throw error;
    }
  }

  async createMentorBookingCheckout(
    input: MentorPaymentCheckoutInput,
  ): Promise<CheckoutResponseDto> {
    const order = await this.createPendingOrder({
      userId: input.userId,
      amountVnd: input.amountVnd,
      purpose: 'MENTOR_BOOKING',
      targetType: 'MENTOR_BOOKING',
      targetId: input.bookingId,
      planCode: null,
      currency: input.currency,
      originalAmountVnd: input.amountVnd,
      discountPercent: 0,
      discountAmountVnd: 0,
      voucherId: null,
      voucherCode: null,
      expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
    });
    return this.createProviderLink(order, 'Mentor session', order.expiresAt!, input.checkoutOrigin);
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
    originalAmountVnd: number;
    discountPercent: number;
    discountAmountVnd: number;
    voucherId: string | null;
    voucherCode: string | null;
    purpose: PaymentOrderEntity['purpose'];
    targetType: PaymentOrderEntity['targetType'];
    targetId: string | null;
    planCode: string | null;
    creditType?: CreditType | null;
    creditUnits?: number | null;
    currency?: string;
    expiresAt: Date;
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
          expiresAt: input.expiresAt,
        }),
      );
    }
    throw new BadRequestException('Could not generate unique payment orderCode');
  }

  private async createProviderLink(
    order: PaymentOrderEntity,
    itemName: string,
    expiresAt: Date,
    checkoutOrigin?: string,
  ): Promise<CheckoutResponseDto> {
    const provider = this.providers.get(order.provider);
    const link = await provider
      .createPaymentLink({
        orderCode: Number(order.orderCode),
        amountVnd: order.amountVnd,
        description: order.description,
        itemName,
        expiresAt,
        checkoutOrigin,
      })
      .catch(async (error) => {
        order.status = 'FAILED';
        await this.orders.save(order);
        this.logger.warn({
          event: 'payment_link_creation_failed',
          orderId: order.id,
          orderCode: order.orderCode,
          provider: order.provider,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        throw error;
      });
    order.checkoutUrl = link.checkoutUrl;
    order.returnUrl = link.returnUrl;
    order.cancelUrl = link.cancelUrl;
    order.paymentLinkId = link.paymentLinkId;
    order.qrCode = link.qrCode;
    order.providerPayload = link.providerPayload;
    order.expiresAt = link.expiresAt ?? expiresAt;
    const saved = await this.orders.save(order);
    return {
      orderId: saved.id,
      orderCode: Number(saved.orderCode),
      status: saved.status,
      checkoutUrl: saved.checkoutUrl,
      returnUrl: saved.returnUrl,
      qrCode: saved.qrCode,
      paymentLinkId: saved.paymentLinkId,
      expiresAt: saved.expiresAt?.toISOString() ?? null,
      pricing: {
        originalAmountVnd: saved.originalAmountVnd,
        discountPercent: saved.discountPercent,
        discountAmountVnd: saved.discountAmountVnd,
        finalAmountVnd: saved.amountVnd,
        voucherCode: saved.voucherCode,
        currency: saved.currency,
      },
      creditPackage:
        saved.creditType && saved.creditUnits
          ? { creditType: saved.creditType, units: saved.creditUnits }
          : null,
    };
  }
}

export interface MentorPaymentCheckoutInput {
  userId: string;
  bookingId: string;
  amountVnd: number;
  currency: string;
  checkoutOrigin?: string;
}
