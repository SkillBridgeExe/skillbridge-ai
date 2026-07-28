import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { VoucherRedemptionEntity } from '../../database/entities/voucher-redemption.entity';
import { VoucherEntity } from '../../database/entities/voucher.entity';
import { calculateVoucherPricing, normalizeVoucherCode, VoucherPricing } from './voucher-pricing';

export interface VoucherInput {
  planCode: string;
  voucherCode: string;
}

export interface VoucherQuote extends VoucherPricing {
  valid: true;
  voucherCode: string;
  currency: string;
  endsAt: string;
}

export interface VoucherReservation extends VoucherPricing {
  redemptionId: string;
  voucherId: string;
  voucherCode: string;
}

@Injectable()
export class VoucherService {
  constructor(
    @InjectRepository(VoucherEntity) private readonly vouchers: Repository<VoucherEntity>,
    @InjectRepository(VoucherRedemptionEntity)
    private readonly redemptions: Repository<VoucherRedemptionEntity>,
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async quote(userId: string, input: VoucherInput, now = new Date()): Promise<VoucherQuote> {
    const code = normalizeVoucherCode(input.voucherCode);
    const voucher = await this.vouchers.findOne({ where: { code } });
    const plan = await this.requirePurchasablePlan(input.planCode);
    await this.releaseExpired(this.redemptions, now);
    await this.assertVoucherAvailable(this.redemptions, voucher, userId, plan.code, now);
    return {
      valid: true,
      voucherCode: voucher!.code,
      currency: plan.currency,
      ...calculateVoucherPricing(plan.priceVnd, voucher!.discountPercent),
      endsAt: voucher!.endsAt.toISOString(),
    };
  }

  async reserve(
    userId: string,
    input: VoucherInput,
    reservedUntil: Date,
    now = new Date(),
  ): Promise<VoucherReservation> {
    const code = normalizeVoucherCode(input.voucherCode);
    return this.dataSource.transaction(async (manager) => {
      const vouchers = manager.getRepository(VoucherEntity);
      const redemptions = manager.getRepository(VoucherRedemptionEntity);
      const plans = manager.getRepository(BillingPlanEntity);
      const voucher = await vouchers.findOne({
        where: { code },
        lock: { mode: 'pessimistic_write' },
      });
      const plan = await this.requirePurchasablePlan(input.planCode, plans);
      await this.releaseExpired(redemptions, now);
      await this.assertVoucherAvailable(redemptions, voucher, userId, plan.code, now);
      const redemption = await redemptions.save(
        redemptions.create({
          voucherId: voucher!.id,
          userId,
          paymentOrderId: null,
          status: 'RESERVED',
          reservedUntil,
          redeemedAt: null,
        }),
      );
      return {
        redemptionId: redemption.id,
        voucherId: voucher!.id,
        voucherCode: voucher!.code,
        ...calculateVoucherPricing(plan.priceVnd, voucher!.discountPercent),
      };
    });
  }

  async attachOrder(redemptionId: string, paymentOrderId: string): Promise<void> {
    await this.redemptions.update(redemptionId, { paymentOrderId });
  }

  async releaseReservation(redemptionId: string): Promise<void> {
    await this.redemptions.update({ id: redemptionId, status: 'RESERVED' }, { status: 'RELEASED' });
  }

  async releaseByOrder(paymentOrderId: string): Promise<void> {
    await this.redemptions.update({ paymentOrderId, status: 'RESERVED' }, { status: 'RELEASED' });
  }

  private async releaseExpired(
    redemptions: Repository<VoucherRedemptionEntity>,
    now: Date,
  ): Promise<void> {
    await redemptions.update(
      { status: 'RESERVED', reservedUntil: LessThanOrEqual(now) },
      { status: 'RELEASED' },
    );
  }

  private async requirePurchasablePlan(
    planCode: string,
    plans: Repository<BillingPlanEntity> = this.plans,
  ): Promise<BillingPlanEntity> {
    const plan = await plans.findOne({
      where: {
        code: planCode.trim().toUpperCase(),
        category: 'SUBSCRIPTION',
        isActive: true,
      },
    });
    if (!plan || plan.code !== 'PREMIUM' || plan.priceVnd <= 0) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VOUCHER_INVALID,
        message: 'Voucher is not applicable to this plan',
      });
    }
    return plan;
  }

  private async assertVoucherAvailable(
    redemptions: Repository<VoucherRedemptionEntity>,
    voucher: VoucherEntity | null,
    userId: string,
    planCode: string,
    now: Date,
  ): Promise<void> {
    if (!voucher || !voucher.isActive || voucher.applicablePlanCode !== planCode) {
      throwVoucher(ERROR_CODES.VOUCHER_INVALID, 'Voucher is invalid');
    }
    if (voucher.startsAt > now) {
      throwVoucher(ERROR_CODES.VOUCHER_NOT_STARTED, 'Voucher is not active yet');
    }
    if (voucher.endsAt <= now) {
      throwVoucher(ERROR_CODES.VOUCHER_EXPIRED, 'Voucher has expired');
    }
    const activeWhere = [
      { voucherId: voucher.id, status: 'REDEEMED' as const },
      {
        voucherId: voucher.id,
        status: 'RESERVED' as const,
        reservedUntil: MoreThan(now),
      },
    ];
    const globalUsed = await redemptions.count({ where: activeWhere });
    if (globalUsed >= voucher.maxRedemptions) {
      throwVoucher(ERROR_CODES.VOUCHER_EXHAUSTED, 'Voucher has reached its usage limit', true);
    }
    const userUsed = await redemptions.count({
      where: activeWhere.map((where) => ({ ...where, userId })),
    });
    if (userUsed >= voucher.perUserLimit) {
      throwVoucher(
        ERROR_CODES.VOUCHER_USER_LIMIT_REACHED,
        'You have reached the usage limit for this voucher',
        true,
      );
    }
  }
}

function throwVoucher(errorCode: string, message: string, conflict = false): never {
  const body = { errorCode, message };
  if (conflict) throw new ConflictException(body);
  throw new BadRequestException(body);
}
