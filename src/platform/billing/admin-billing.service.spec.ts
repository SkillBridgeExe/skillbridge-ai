import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { BillingFeatureKey, BillingFeaturePeriod } from '../../common/constants/billing.constants';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { MentorBookingEntity } from '../../database/entities/mentor-booking.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { UserSubscriptionEntity } from '../../database/entities/user-subscription.entity';
import { AdminBillingService } from './admin-billing.service';

type RepositoryMock<T extends object> = Pick<
  Repository<T>,
  'create' | 'delete' | 'find' | 'findAndCount' | 'findOne' | 'save'
> & {
  create: jest.Mock;
  delete: jest.Mock;
  find: jest.Mock;
  findAndCount: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
};

function createRepositoryMock<T extends object>(): RepositoryMock<T> {
  return {
    create: jest.fn((input) => input),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn(),
    findAndCount: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve(input)),
  } as unknown as RepositoryMock<T>;
}

describe('AdminBillingService', () => {
  function setup() {
    const plans = createRepositoryMock<BillingPlanEntity>();
    const features = createRepositoryMock<PlanFeatureEntity>();
    const orders = createRepositoryMock<PaymentOrderEntity>();
    const subscriptions = createRepositoryMock<UserSubscriptionEntity>();
    const mentorBookings = createRepositoryMock<MentorBookingEntity>();
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === BillingPlanEntity) return plans;
        if (entity === PlanFeatureEntity) return features;
        if (entity === PaymentOrderEntity) return orders;
        if (entity === UserSubscriptionEntity) return subscriptions;
        if (entity === MentorBookingEntity) return mentorBookings;
        throw new Error(`Unexpected repository: ${String(entity)}`);
      }),
    };
    const dataSource = {
      transaction: jest.fn((callback) => callback(manager)),
    } as unknown as DataSource & { transaction: jest.Mock };
    const service = new (AdminBillingService as any)(
      plans as unknown as Repository<BillingPlanEntity>,
      features as unknown as Repository<PlanFeatureEntity>,
      orders as unknown as Repository<PaymentOrderEntity>,
      subscriptions as unknown as Repository<UserSubscriptionEntity>,
      mentorBookings as unknown as Repository<MentorBookingEntity>,
      dataSource,
    ) as AdminBillingService;
    return { service, plans, features, orders, subscriptions, mentorBookings, dataSource };
  }

  it('lists feature catalog metadata for FE quota forms', () => {
    const { service } = setup();

    const result = (service as any).listFeatureCatalog();

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureKey: BillingFeatureKey.CV_REVIEW,
          label: 'CV diagnosis',
          allowedPeriods: [BillingFeaturePeriod.MONTHLY],
          recommendedLimits: expect.objectContaining({
            FREE: 3,
            PRO: 30,
            PREMIUM: 100,
          }),
        }),
        expect.objectContaining({
          featureKey: BillingFeatureKey.ROADMAP_GENERATE,
          recommendedLimits: expect.objectContaining({
            FREE: 1,
            PRO: 10,
            PREMIUM: 30,
          }),
        }),
      ]),
    );
  });

  it('creates a plan and its feature limits', async () => {
    const { service, plans, features } = setup();
    plans.findOne.mockResolvedValue(null);
    plans.save.mockImplementation((input) =>
      Promise.resolve({ id: 'plan-id', createdAt: new Date(), updatedAt: null, ...input }),
    );
    features.find.mockResolvedValue([
      {
        planCode: 'PRO',
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 50,
        period: BillingFeaturePeriod.MONTHLY,
      },
    ]);

    const result = await service.createPlan({
      code: 'pro',
      name: 'Pro',
      category: 'SUBSCRIPTION',
      interval: 'MONTHLY',
      priceVnd: 129000,
      features: [{ featureKey: BillingFeatureKey.CV_REVIEW, limitValue: 50 }],
    });

    expect(plans.save).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PRO', priceVnd: 129000, isActive: true }),
    );
    expect(features.save).toHaveBeenCalledWith([
      expect.objectContaining({
        planCode: 'PRO',
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 50,
      }),
    ]);
    expect(result.code).toBe('PRO');
  });

  it('rejects duplicate feature keys when replacing plan features', async () => {
    const { service, plans } = setup();
    plans.findOne.mockResolvedValue({ code: 'PRO' });

    await expect(
      service.replacePlanFeatures('PRO', {
        features: [
          { featureKey: BillingFeatureKey.CV_REVIEW, limitValue: 10 },
          { featureKey: BillingFeatureKey.CV_REVIEW, limitValue: 20 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('replaces plan features inside a transaction', async () => {
    const { service, plans, features, dataSource } = setup();
    plans.findOne.mockResolvedValue({ code: 'PRO' });
    features.find.mockResolvedValue([
      {
        planCode: 'PRO',
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 30,
        period: BillingFeaturePeriod.MONTHLY,
      },
    ]);

    await service.replacePlanFeatures('PRO', {
      features: [{ featureKey: BillingFeatureKey.CV_REVIEW, limitValue: 30 }],
    });

    expect(dataSource.transaction).toHaveBeenCalled();
    expect(features.delete).toHaveBeenCalledWith({ planCode: 'PRO' });
    expect(features.save).toHaveBeenCalledWith([
      expect.objectContaining({
        planCode: 'PRO',
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 30,
      }),
    ]);
  });

  it('rejects unsupported catalog periods before replacing plan features', async () => {
    const { service, plans, features, dataSource } = setup();
    plans.findOne.mockResolvedValue({ code: 'PRO' });
    features.find.mockResolvedValue([]);

    await expect(
      service.replacePlanFeatures('PRO', {
        features: [
          {
            featureKey: BillingFeatureKey.CV_REVIEW,
            limitValue: 5,
            period: BillingFeaturePeriod.DAILY,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(features.delete).not.toHaveBeenCalled();
    expect(features.save).not.toHaveBeenCalled();
  });

  it('updates one existing feature limit without replacing other plan features', async () => {
    const { service, plans, features } = setup();
    plans.findOne.mockResolvedValue({ code: 'PRO' });
    features.findOne.mockResolvedValue({
      id: 'feature-1',
      planCode: 'PRO',
      featureKey: BillingFeatureKey.CV_REVIEW,
      limitValue: 30,
      period: BillingFeaturePeriod.MONTHLY,
    });
    features.find.mockResolvedValue([
      {
        id: 'feature-1',
        planCode: 'PRO',
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 20,
        period: BillingFeaturePeriod.MONTHLY,
      },
      {
        id: 'feature-2',
        planCode: 'PRO',
        featureKey: BillingFeatureKey.CV_JD_MATCH,
        limitValue: 30,
        period: BillingFeaturePeriod.MONTHLY,
      },
    ]);

    const result = await (service as any).updatePlanFeature('PRO', BillingFeatureKey.CV_REVIEW, {
      limitValue: 20,
      period: BillingFeaturePeriod.MONTHLY,
    });

    expect(features.delete).not.toHaveBeenCalled();
    expect(features.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'feature-1',
        planCode: 'PRO',
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 20,
        period: BillingFeaturePeriod.MONTHLY,
      }),
    );
    expect(result.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureKey: BillingFeatureKey.CV_JD_MATCH,
          limitValue: 30,
        }),
      ]),
    );
  });

  it('rejects unsupported catalog periods when updating one feature', async () => {
    const { service, plans, features } = setup();
    plans.findOne.mockResolvedValue({ code: 'PRO' });
    features.find.mockResolvedValue([]);
    features.findOne.mockResolvedValue({
      id: 'feature-1',
      planCode: 'PRO',
      featureKey: BillingFeatureKey.CV_REVIEW,
      limitValue: 30,
      period: BillingFeaturePeriod.MONTHLY,
    });

    await expect(
      (service as any).updatePlanFeature('PRO', BillingFeatureKey.CV_REVIEW, {
        limitValue: 20,
        period: BillingFeaturePeriod.DAILY,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(features.save).not.toHaveBeenCalled();
  });

  it('keeps an existing allowed period when updating one feature without period', async () => {
    const { service, plans, features } = setup();
    plans.findOne.mockResolvedValue({ code: 'PRO' });
    features.findOne.mockResolvedValue({
      id: 'feature-1',
      planCode: 'PRO',
      featureKey: BillingFeatureKey.CV_REVIEW,
      limitValue: 30,
      period: BillingFeaturePeriod.MONTHLY,
    });
    features.find.mockResolvedValue([
      {
        id: 'feature-1',
        planCode: 'PRO',
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 20,
        period: BillingFeaturePeriod.MONTHLY,
      },
    ]);

    await (service as any).updatePlanFeature('PRO', BillingFeatureKey.CV_REVIEW, {
      limitValue: 20,
    });

    expect(features.save).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: BillingFeatureKey.CV_REVIEW,
        limitValue: 20,
        period: BillingFeaturePeriod.MONTHLY,
      }),
    );
  });

  it('creates one missing feature limit for an existing plan', async () => {
    const { service, plans, features } = setup();
    plans.findOne.mockResolvedValue({ code: 'PRO' });
    features.findOne.mockResolvedValue(null);
    features.find.mockResolvedValue([
      {
        planCode: 'PRO',
        featureKey: BillingFeatureKey.ROADMAP_GENERATE,
        limitValue: 10,
        period: BillingFeaturePeriod.MONTHLY,
      },
    ]);

    await (service as any).updatePlanFeature('PRO', BillingFeatureKey.ROADMAP_GENERATE, {
      limitValue: 10,
    });

    expect(features.save).toHaveBeenCalledWith(
      expect.objectContaining({
        planCode: 'PRO',
        featureKey: BillingFeatureKey.ROADMAP_GENERATE,
        limitValue: 10,
        period: BillingFeaturePeriod.MONTHLY,
      }),
    );
  });

  it('updates plan price without changing its code', async () => {
    const { service, plans, features } = setup();
    plans.findOne.mockResolvedValue({
      code: 'PRO',
      name: 'Pro',
      description: null,
      category: 'SUBSCRIPTION',
      interval: 'MONTHLY',
      priceVnd: 99000,
      currency: 'VND',
      isActive: true,
      sortOrder: 10,
      metadata: null,
    });
    plans.save.mockImplementation((input) =>
      Promise.resolve({ createdAt: new Date(), updatedAt: null, ...input }),
    );
    features.find.mockResolvedValue([]);

    const result = await service.updatePlan('pro', { priceVnd: 129000, isActive: false });

    expect(plans.save).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PRO', priceVnd: 129000 }),
    );
    expect(result).toEqual(
      expect.objectContaining({ code: 'PRO', priceVnd: 129000, isActive: false }),
    );
  });

  it('throws when updating an unknown plan', async () => {
    const { service, plans } = setup();
    plans.findOne.mockResolvedValue(null);

    await expect(service.updatePlan('MISSING', { priceVnd: 1 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists payment orders with pagination filters', async () => {
    const { service, orders } = setup();
    orders.findAndCount.mockResolvedValue([
      [
        {
          id: 'order-1',
          userId: 'user-1',
          orderCode: '123',
          purpose: 'SUBSCRIPTION',
          status: 'PAID',
          amountVnd: 129000,
          currency: 'VND',
          planCode: 'PRO',
          targetType: 'SUBSCRIPTION',
          targetId: null,
          paymentLinkId: 'plink',
          checkoutUrl: 'https://pay.test',
          paidAt: new Date('2026-06-01T00:00:00.000Z'),
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
          updatedAt: null,
        },
      ],
      1,
    ]);

    const result = await service.listOrders({
      status: 'PAID',
      purpose: 'SUBSCRIPTION',
      page: 2,
      limit: 5,
    });

    expect(orders.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PAID', purpose: 'SUBSCRIPTION' },
        skip: 5,
        take: 5,
      }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual(expect.objectContaining({ orderCode: 123, status: 'PAID' }));
  });

  it('records a manual refund outcome only for bookings pending refund review', async () => {
    const { service, mentorBookings } = setup();
    mentorBookings.findOne.mockResolvedValue({
      id: 'booking-1',
      status: 'CANCELLED',
      refundStatus: 'PENDING',
      refundNote: null,
      updatedAt: null,
    });

    const result = await service.updateMentorBookingRefund('booking-1', {
      status: 'PROCESSED',
      note: 'Refunded manually in PayOS dashboard, reference RF-123',
    });

    expect(mentorBookings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        refundStatus: 'PROCESSED',
        refundNote: 'Refunded manually in PayOS dashboard, reference RF-123',
      }),
    );
    expect(result).toEqual(expect.objectContaining({ id: 'booking-1', refundStatus: 'PROCESSED' }));
  });
});
