import { HttpException } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';

function repo<T>(partial: Partial<Record<keyof any, jest.Mock>>): T {
  return partial as T;
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
      repo({ findOne: jest.fn().mockResolvedValue({ code: 'FREE' }) }),
      repo({
        find: jest
          .fn()
          .mockResolvedValue([
            { planCode: 'FREE', featureKey: 'cv_review', limitValue: 3, period: 'MONTHLY' },
          ]),
      }),
      repo({ findOne: jest.fn().mockResolvedValue(null) }),
      usageRepo([{ featureKey: 'cv_review', count: '2' }]) as never,
    );

    await expect(service.assertCanUse('user-1', 'cv_review')).resolves.toBeUndefined();
  });

  it('blocks a feature with limit 0', async () => {
    const service = new EntitlementsService(
      repo({ findOne: jest.fn().mockResolvedValue({ code: 'FREE' }) }),
      repo({
        find: jest.fn().mockResolvedValue([
          {
            planCode: 'FREE',
            featureKey: 'cv_builder_rewrite',
            limitValue: 0,
            period: 'MONTHLY',
          },
        ]),
      }),
      repo({ findOne: jest.fn().mockResolvedValue(null) }),
      usageRepo([]) as never,
    );

    await expect(service.assertCanUse('user-1', 'cv_builder_rewrite')).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('allows unlimited usage when limit is -1', async () => {
    const service = new EntitlementsService(
      repo({ findOne: jest.fn().mockResolvedValue({ code: 'PREMIUM' }) }),
      repo({
        find: jest
          .fn()
          .mockResolvedValue([
            { planCode: 'PREMIUM', featureKey: 'cv_review', limitValue: -1, period: 'MONTHLY' },
          ]),
      }),
      repo({
        findOne: jest.fn().mockResolvedValue({
          id: 'sub-1',
          planCode: 'PREMIUM',
          status: 'ACTIVE',
          currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
        }),
      }),
      usageRepo([{ featureKey: 'cv_review', count: '999' }]) as never,
    );

    await expect(service.assertCanUse('user-1', 'cv_review')).resolves.toBeUndefined();
  });
});
