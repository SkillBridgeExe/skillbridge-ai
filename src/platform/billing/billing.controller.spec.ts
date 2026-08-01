import { BillingController, MeEntitlementsController } from './billing.controller';

describe('BillingController', () => {
  it('resolves and forwards the browser checkout origin without adding it to the DTO', async () => {
    const billing = { createCheckout: jest.fn().mockResolvedValue({ orderCode: 123 }) };
    const origins = {
      resolve: jest.fn().mockReturnValue('https://skillbridgebuilder.com'),
    };
    const controller = new BillingController(billing as never, {} as never, origins as never);
    const dto = { purpose: 'SUBSCRIPTION', planCode: 'PREMIUM' } as const;

    await controller.checkout(
      { userId: 'user-1' } as never,
      dto,
      'https://skillbridgebuilder.com',
      'https://skillbridgebuilder.com/pricing',
    );

    expect(origins.resolve).toHaveBeenCalledWith(
      'https://skillbridgebuilder.com',
      'https://skillbridgebuilder.com/pricing',
    );
    expect(billing.createCheckout).toHaveBeenCalledWith(
      'user-1',
      dto,
      'https://skillbridgebuilder.com',
    );
  });

  it('prevents browser caching on the dynamic order status endpoint', () => {
    const headers = Reflect.getMetadata('__headers__', BillingController.prototype.order);

    expect(headers).toContainEqual({
      name: 'Cache-Control',
      value: 'private, no-store, max-age=0',
    });
  });
});

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
