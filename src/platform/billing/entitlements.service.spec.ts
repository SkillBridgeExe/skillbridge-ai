import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
  BillingPlanCode,
  UNLIMITED_BILLING_LIMIT,
} from '../../common/constants/billing.constants';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { UsageEventEntity } from '../../database/entities/usage-event.entity';
import { UserSubscriptionEntity } from '../../database/entities/user-subscription.entity';
import { EntitlementsService } from './entitlements.service';

function repo<T extends object>(
  partial: Partial<Record<keyof Repository<T>, jest.Mock>>,
): Repository<T> {
  return partial as unknown as Repository<T>;
}

function usageRepo(rows: Array<{ featureKey: string; count: string }>) {
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  return {
    qb,
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    create: jest.fn((input) => input),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe('EntitlementsService', () => {
  it('allows usage below a positive monthly limit', async () => {
    const service = new EntitlementsService(
      repo<BillingPlanEntity>({
        findOne: jest.fn().mockResolvedValue({ code: BillingPlanCode.FREE }),
      }),
      repo<PlanFeatureEntity>({
        find: jest.fn().mockResolvedValue([
          {
            planCode: BillingPlanCode.FREE,
            featureKey: BillingFeatureKey.CV_REVIEW,
            limitValue: 3,
            period: BillingFeaturePeriod.MONTHLY,
          },
        ]),
      }),
      repo<UserSubscriptionEntity>({ findOne: jest.fn().mockResolvedValue(null) }),
      usageRepo([
        { featureKey: BillingFeatureKey.CV_REVIEW, count: '2' },
      ]) as unknown as Repository<UsageEventEntity>,
    );

    await expect(
      service.assertCanUse('user-1', BillingFeatureKey.CV_REVIEW),
    ).resolves.toBeUndefined();
  });

  it('blocks a feature with limit 0', async () => {
    const service = new EntitlementsService(
      repo<BillingPlanEntity>({
        findOne: jest.fn().mockResolvedValue({ code: BillingPlanCode.FREE }),
      }),
      repo<PlanFeatureEntity>({
        find: jest.fn().mockResolvedValue([
          {
            planCode: BillingPlanCode.FREE,
            featureKey: BillingFeatureKey.CV_BUILDER_REWRITE,
            limitValue: 0,
            period: BillingFeaturePeriod.MONTHLY,
          },
        ]),
      }),
      repo<UserSubscriptionEntity>({ findOne: jest.fn().mockResolvedValue(null) }),
      usageRepo([]) as unknown as Repository<UsageEventEntity>,
    );

    await expect(
      service.assertCanUse('user-1', BillingFeatureKey.CV_BUILDER_REWRITE),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('allows unlimited usage when limit is -1', async () => {
    const service = new EntitlementsService(
      repo<BillingPlanEntity>({
        findOne: jest.fn().mockResolvedValue({ code: BillingPlanCode.PREMIUM }),
      }),
      repo<PlanFeatureEntity>({
        find: jest.fn().mockResolvedValue([
          {
            planCode: BillingPlanCode.PREMIUM,
            featureKey: BillingFeatureKey.CV_REVIEW,
            limitValue: UNLIMITED_BILLING_LIMIT,
            period: BillingFeaturePeriod.MONTHLY,
          },
        ]),
      }),
      repo<UserSubscriptionEntity>({
        findOne: jest.fn().mockResolvedValue({
          id: 'sub-1',
          planCode: BillingPlanCode.PREMIUM,
          status: 'ACTIVE',
          currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
        }),
      }),
      usageRepo([
        { featureKey: BillingFeatureKey.CV_REVIEW, count: '999' },
      ]) as unknown as Repository<UsageEventEntity>,
    );

    await expect(
      service.assertCanUse('user-1', BillingFeatureKey.CV_REVIEW),
    ).resolves.toBeUndefined();
  });

  it('counts a DAILY feature from the current ICT day and returns its reset time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-10T10:15:00.000Z'));
    const usage = usageRepo([{ featureKey: BillingFeatureKey.CV_REVIEW, count: '4' }]);
    const service = new EntitlementsService(
      repo<BillingPlanEntity>({
        findOne: jest.fn().mockResolvedValue({ code: BillingPlanCode.FREE }),
      }),
      repo<PlanFeatureEntity>({
        find: jest.fn().mockResolvedValue([
          {
            planCode: BillingPlanCode.FREE,
            featureKey: BillingFeatureKey.CV_REVIEW,
            limitValue: 5,
            period: BillingFeaturePeriod.DAILY,
          },
        ]),
      }),
      repo<UserSubscriptionEntity>({ findOne: jest.fn().mockResolvedValue(null) }),
      usage as unknown as Repository<UsageEventEntity>,
    );

    const entitlement = await service.getCurrentEntitlements('user-1');

    expect(entitlement.features[0]).toEqual(
      expect.objectContaining({
        featureKey: BillingFeatureKey.CV_REVIEW,
        limit: 5,
        period: BillingFeaturePeriod.DAILY,
        used: 4,
        remaining: 1,
        resetsAt: '2026-06-10T17:00:00.000Z',
      }),
    );
    expect(usage.qb.andWhere).toHaveBeenCalledWith('usage.used_at >= :periodStart', {
      periodStart: new Date('2026-06-09T17:00:00.000Z'),
    });
    expect(usage.qb.andWhere).toHaveBeenCalledWith('usage.used_at < :periodEnd', {
      periodEnd: new Date('2026-06-10T17:00:00.000Z'),
    });
    jest.useRealTimers();
  });

  it('counts mixed DAILY and MONTHLY features with separate usage windows', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-10T10:15:00.000Z'));
    const usage = usageRepo([]);
    const service = new EntitlementsService(
      repo<BillingPlanEntity>({
        findOne: jest.fn().mockResolvedValue({ code: BillingPlanCode.FREE }),
      }),
      repo<PlanFeatureEntity>({
        find: jest.fn().mockResolvedValue([
          {
            planCode: BillingPlanCode.FREE,
            featureKey: BillingFeatureKey.CV_REVIEW,
            limitValue: 5,
            period: BillingFeaturePeriod.DAILY,
          },
          {
            planCode: BillingPlanCode.FREE,
            featureKey: BillingFeatureKey.CV_JD_MATCH,
            limitValue: 3,
            period: BillingFeaturePeriod.MONTHLY,
          },
        ]),
      }),
      repo<UserSubscriptionEntity>({ findOne: jest.fn().mockResolvedValue(null) }),
      usage as unknown as Repository<UsageEventEntity>,
    );

    await service.getCurrentEntitlements('user-1');

    expect(usage.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(usage.qb.andWhere).toHaveBeenCalledWith('usage.used_at >= :periodStart', {
      periodStart: new Date('2026-05-31T17:00:00.000Z'),
    });
    expect(usage.qb.andWhere).toHaveBeenCalledWith('usage.used_at < :periodEnd', {
      periodEnd: new Date('2026-06-30T17:00:00.000Z'),
    });
    jest.useRealTimers();
  });
});
