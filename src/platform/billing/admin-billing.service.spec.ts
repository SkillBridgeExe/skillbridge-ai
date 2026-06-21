import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
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
    const service = new AdminBillingService(
      plans as unknown as Repository<BillingPlanEntity>,
      features as unknown as Repository<PlanFeatureEntity>,
      orders as unknown as Repository<PaymentOrderEntity>,
      subscriptions as unknown as Repository<UserSubscriptionEntity>,
      mentorBookings as unknown as Repository<MentorBookingEntity>,
    );
    return { service, plans, features, orders, subscriptions, mentorBookings };
  }

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
