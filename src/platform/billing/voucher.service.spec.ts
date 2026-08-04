import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { VoucherRedemptionEntity } from '../../database/entities/voucher-redemption.entity';
import { VoucherEntity } from '../../database/entities/voucher.entity';
import { CreditBalanceService } from './credit-balance.service';
import { VoucherService } from './voucher.service';

function repo<T extends object>(overrides: Partial<Repository<T>> = {}): Repository<T> {
  return {
    findOne: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn((input) => input),
    save: jest.fn(async (input) => ({ id: 'saved-id', ...input })),
    ...overrides,
  } as unknown as Repository<T>;
}

describe('VoucherService', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');
  const voucher = {
    id: 'voucher-1',
    code: 'SKILLBRIDGE10',
    benefitType: 'PERCENT_DISCOUNT',
    discountPercent: 10,
    applicablePlanCode: 'PREMIUM',
    creditType: null,
    creditUnits: null,
    startsAt: new Date('2026-07-01T00:00:00.000Z'),
    endsAt: new Date('2026-08-01T00:00:00.000Z'),
    maxRedemptions: 100,
    perUserLimit: 1,
    isActive: true,
    internalNote: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: null,
  } as VoucherEntity;

  function setup() {
    const vouchers = repo<VoucherEntity>({
      findOne: jest.fn().mockResolvedValue(voucher),
    });
    const redemptions = repo<VoucherRedemptionEntity>();
    const plans = repo<BillingPlanEntity>({
      findOne: jest.fn().mockResolvedValue({
        code: 'PREMIUM',
        priceVnd: 199000,
        currency: 'VND',
        category: 'SUBSCRIPTION',
        isActive: true,
      }),
    });
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === VoucherEntity) return vouchers;
        if (entity === VoucherRedemptionEntity) return redemptions;
        return plans;
      }),
    };
    const dataSource = {
      transaction: jest.fn(async (callback) => callback(manager)),
    } as unknown as DataSource;
    const creditBalances = {
      grantInTransaction: jest.fn().mockResolvedValue(undefined),
    } as unknown as CreditBalanceService;
    return {
      service: new VoucherService(vouchers, redemptions, plans, dataSource, creditBalances),
      vouchers,
      redemptions,
      creditBalances,
      dataSource,
      manager,
    };
  }

  it('returns a server-priced quote for a valid Premium voucher', async () => {
    const { service } = setup();

    const result = await service.quote(
      'user-1',
      { planCode: 'PREMIUM', voucherCode: ' skillbridge10 ' },
      now,
    );

    expect(result).toEqual({
      valid: true,
      voucherCode: 'SKILLBRIDGE10',
      currency: 'VND',
      discountPercent: 10,
      originalAmountVnd: 199000,
      discountAmountVnd: 19900,
      finalAmountVnd: 179100,
      endsAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('rejects a voucher after the global redemption limit is reached', async () => {
    const { service, redemptions } = setup();
    (redemptions.count as jest.Mock).mockResolvedValueOnce(100);

    await expect(
      service.quote('user-1', { planCode: 'PREMIUM', voucherCode: 'SKILLBRIDGE10' }, now),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('allows only one concurrent reservation for the last voucher slot', async () => {
    const { service, vouchers, redemptions, dataSource, manager } = setup();
    const originalLimit = voucher.maxRedemptions;
    voucher.maxRedemptions = 1;
    let reserved = 0;
    let queue = Promise.resolve();
    (dataSource.transaction as jest.Mock).mockImplementation((callback) => {
      const result = queue.then(() => callback(manager));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    (redemptions.count as jest.Mock).mockImplementation(async () => reserved);
    (redemptions.save as jest.Mock).mockImplementation(async (input) => {
      reserved += 1;
      return { id: `redemption-${reserved}`, ...input };
    });

    try {
      const results = await Promise.allSettled([
        service.reserve(
          'user-1',
          { planCode: 'PREMIUM', voucherCode: voucher.code },
          new Date('2026-07-29T00:15:00.000Z'),
          now,
        ),
        service.reserve(
          'user-2',
          { planCode: 'PREMIUM', voucherCode: voucher.code },
          new Date('2026-07-29T00:15:00.000Z'),
          now,
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(vouchers.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    } finally {
      voucher.maxRedemptions = originalLimit;
    }
  });

  it('claims a credit voucher and grants its configured reward in the same transaction', async () => {
    const { service, redemptions, creditBalances, manager } = setup();
    Object.assign(voucher, {
      benefitType: 'CREDIT_GRANT',
      discountPercent: null,
      applicablePlanCode: null,
      creditType: 'CV_ANALYSIS',
      creditUnits: 3,
    });

    try {
      await expect(service.claim('user-1', voucher.code, now)).resolves.toEqual({
        voucherCode: 'SKILLBRIDGE10',
        creditType: 'CV_ANALYSIS',
        creditUnits: 3,
        redeemedAt: now.toISOString(),
      });
      expect(redemptions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          voucherId: 'voucher-1',
          userId: 'user-1',
          paymentOrderId: null,
          status: 'REDEEMED',
          reservedUntil: null,
          redeemedAt: now,
        }),
      );
      expect(creditBalances.grantInTransaction).toHaveBeenCalledWith(
        manager,
        'user-1',
        'CV_ANALYSIS',
        3,
      );
    } finally {
      Object.assign(voucher, {
        benefitType: 'PERCENT_DISCOUNT',
        discountPercent: 10,
        applicablePlanCode: 'PREMIUM',
        creditType: null,
        creditUnits: null,
      });
    }
  });

  it('rejects credit vouchers in the Premium pricing flow', async () => {
    const { service } = setup();
    Object.assign(voucher, {
      benefitType: 'CREDIT_GRANT',
      discountPercent: null,
      applicablePlanCode: null,
      creditType: 'INTERVIEW_SESSION',
      creditUnits: 1,
    });

    try {
      await expect(
        service.quote('user-1', { planCode: 'PREMIUM', voucherCode: voucher.code }, now),
      ).rejects.toBeInstanceOf(HttpException);
    } finally {
      Object.assign(voucher, {
        benefitType: 'PERCENT_DISCOUNT',
        discountPercent: 10,
        applicablePlanCode: 'PREMIUM',
        creditType: null,
        creditUnits: null,
      });
    }
  });

  it('serializes simultaneous claims and enforces the per-user limit', async () => {
    const { service, redemptions, creditBalances, dataSource, manager } = setup();
    let redeemed = 0;
    let queue = Promise.resolve();
    Object.assign(voucher, {
      benefitType: 'CREDIT_GRANT',
      discountPercent: null,
      applicablePlanCode: null,
      creditType: 'INTERVIEW_SESSION',
      creditUnits: 1,
    });
    (dataSource.transaction as jest.Mock).mockImplementation((callback) => {
      const result = queue.then(() => callback(manager));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    (redemptions.count as jest.Mock).mockImplementation(async () => redeemed);
    (redemptions.save as jest.Mock).mockImplementation(async (input) => {
      redeemed += 1;
      return { id: `redemption-${redeemed}`, ...input };
    });

    try {
      const results = await Promise.allSettled([
        service.claim('user-1', voucher.code, now),
        service.claim('user-1', voucher.code, now),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(creditBalances.grantInTransaction).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(voucher, {
        benefitType: 'PERCENT_DISCOUNT',
        discountPercent: 10,
        applicablePlanCode: 'PREMIUM',
        creditType: null,
        creditUnits: null,
      });
    }
  });
});
