import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';
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
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    create: jest.fn((input) => input),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe('EntitlementsService', () => {
  it('allows usage below a positive monthly limit', async () => {
    const service = new EntitlementsService(
      repo<BillingPlanEntity>({ findOne: jest.fn().mockResolvedValue({ code: 'FREE' }) }),
      repo<PlanFeatureEntity>({
        find: jest
          .fn()
          .mockResolvedValue([
            { planCode: 'FREE', featureKey: 'cv_review', limitValue: 3, period: 'MONTHLY' },
          ]),
      }),
      repo<UserSubscriptionEntity>({ findOne: jest.fn().mockResolvedValue(null) }),
      usageRepo([
        { featureKey: 'cv_review', count: '2' },
      ]) as unknown as Repository<UsageEventEntity>,
    );

    await expect(service.assertCanUse('user-1', 'cv_review')).resolves.toBeUndefined();
  });

  it('blocks a feature with limit 0', async () => {
    const service = new EntitlementsService(
      repo<BillingPlanEntity>({ findOne: jest.fn().mockResolvedValue({ code: 'FREE' }) }),
      repo<PlanFeatureEntity>({
        find: jest.fn().mockResolvedValue([
          {
            planCode: 'FREE',
            featureKey: 'cv_builder_rewrite',
            limitValue: 0,
            period: 'MONTHLY',
          },
        ]),
      }),
      repo<UserSubscriptionEntity>({ findOne: jest.fn().mockResolvedValue(null) }),
      usageRepo([]) as unknown as Repository<UsageEventEntity>,
    );

    await expect(service.assertCanUse('user-1', 'cv_builder_rewrite')).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('allows unlimited usage when limit is -1', async () => {
    const service = new EntitlementsService(
      repo<BillingPlanEntity>({ findOne: jest.fn().mockResolvedValue({ code: 'PREMIUM' }) }),
      repo<PlanFeatureEntity>({
        find: jest
          .fn()
          .mockResolvedValue([
            { planCode: 'PREMIUM', featureKey: 'cv_review', limitValue: -1, period: 'MONTHLY' },
          ]),
      }),
      repo<UserSubscriptionEntity>({
        findOne: jest.fn().mockResolvedValue({
          id: 'sub-1',
          planCode: 'PREMIUM',
          status: 'ACTIVE',
          currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
        }),
      }),
      usageRepo([
        { featureKey: 'cv_review', count: '999' },
      ]) as unknown as Repository<UsageEventEntity>,
    );

    await expect(service.assertCanUse('user-1', 'cv_review')).resolves.toBeUndefined();
  });
});
