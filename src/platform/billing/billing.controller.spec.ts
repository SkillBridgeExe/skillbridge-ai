import { MeEntitlementsController } from './billing.controller';

describe('MeEntitlementsController', () => {
  it('returns a flat entitlement list for the current user', async () => {
    const billing = {
      getUsage: jest.fn().mockResolvedValue({
        planCode: 'FREE',
        status: 'FREE',
        currentPeriodStart: '2026-06-09T17:00:00.000Z',
        currentPeriodEnd: '2026-06-10T17:00:00.000Z',
        features: [
          {
            featureKey: 'cv_review',
            limit: 5,
            period: 'DAILY',
            used: 3,
            remaining: 2,
            unlimited: false,
            allowed: true,
            resetsAt: '2026-06-10T17:00:00.000Z',
          },
        ],
      }),
    };
    const controller = new MeEntitlementsController(billing as never);

    await expect(controller.entitlements({ userId: 'user-1' } as never)).resolves.toEqual([
      {
        feature: 'cv_review',
        used: 3,
        limit: 5,
        period: 'DAILY',
        remaining: 2,
        unlimited: false,
        allowed: true,
        resets_at: '2026-06-10T17:00:00.000Z',
      },
    ]);
  });
});
