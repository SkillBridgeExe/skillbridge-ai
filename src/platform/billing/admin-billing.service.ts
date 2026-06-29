import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';
import {
  BILLING_FEATURE_CATALOG,
  BillingFeatureKey,
  BillingFeaturePeriod,
  DEFAULT_BILLING_FEATURE_PERIOD,
} from '../../common/constants/billing.constants';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { MentorBookingEntity } from '../../database/entities/mentor-booking.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { UserSubscriptionEntity } from '../../database/entities/user-subscription.entity';
import {
  AdminListMentorBookingsQueryDto,
  AdminListOrdersQueryDto,
  AdminListPlansQueryDto,
  AdminListSubscriptionsQueryDto,
  CreateAdminBillingPlanDto,
  ReplaceAdminPlanFeaturesDto,
  UpdateAdminBillingPlanDto,
  UpdateAdminMentorBookingRefundDto,
  UpdateAdminPlanFeatureDto,
} from './dto/admin-billing.dto';

type NormalizedPlanFeatureInput = {
  featureKey: BillingFeatureKey;
  limitValue: number;
  period: BillingFeaturePeriod;
};

@Injectable()
export class AdminBillingService {
  constructor(
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    @InjectRepository(PlanFeatureEntity) private readonly features: Repository<PlanFeatureEntity>,
    @InjectRepository(PaymentOrderEntity) private readonly orders: Repository<PaymentOrderEntity>,
    @InjectRepository(UserSubscriptionEntity)
    private readonly subscriptions: Repository<UserSubscriptionEntity>,
    @InjectRepository(MentorBookingEntity)
    private readonly mentorBookings: Repository<MentorBookingEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async listPlans(query: AdminListPlansQueryDto = {}) {
    const plans = await this.plans.find({
      where: query.includeInactive ? {} : { isActive: true },
      order: { sortOrder: 'ASC', priceVnd: 'ASC' },
    });
    return this.mapPlansWithFeatures(plans);
  }

  async createPlan(dto: CreateAdminBillingPlanDto) {
    const code = normalizePlanCode(dto.code);
    const existing = await this.plans.findOne({ where: { code } });
    if (existing) throw new BadRequestException('Billing plan code already exists');

    const plan = await this.plans.save(
      this.plans.create({
        code,
        name: dto.name,
        description: dto.description ?? null,
        category: dto.category,
        interval: dto.interval,
        priceVnd: dto.priceVnd,
        currency: dto.currency ?? 'VND',
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
        metadata: dto.metadata ?? null,
      }),
    );

    if (dto.features) {
      await this.savePlanFeatures(code, normalizePlanFeatureInputs(dto.features));
    }
    return (await this.mapPlansWithFeatures([plan]))[0];
  }

  listFeatureCatalog() {
    return BILLING_FEATURE_CATALOG.map((feature) => ({
      featureKey: feature.featureKey,
      label: feature.label,
      description: feature.description,
      allowedPeriods: [...feature.allowedPeriods],
      recommendedLimits: { ...feature.recommendedLimits },
    }));
  }

  async updatePlan(code: string, dto: UpdateAdminBillingPlanDto) {
    const plan = await this.requirePlan(code);
    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.description !== undefined) plan.description = dto.description;
    if (dto.category !== undefined) plan.category = dto.category;
    if (dto.interval !== undefined) plan.interval = dto.interval;
    if (dto.priceVnd !== undefined) plan.priceVnd = dto.priceVnd;
    if (dto.currency !== undefined) plan.currency = dto.currency;
    if (dto.isActive !== undefined) plan.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) plan.sortOrder = dto.sortOrder;
    if (dto.metadata !== undefined) plan.metadata = dto.metadata;

    const saved = await this.plans.save(plan);
    return (await this.mapPlansWithFeatures([saved]))[0];
  }

  async replacePlanFeatures(code: string, dto: ReplaceAdminPlanFeaturesDto) {
    const normalizedCode = normalizePlanCode(code);
    await this.requirePlan(normalizedCode);
    assertNoDuplicateFeatureKeys(dto.features);
    const normalizedFeatures = normalizePlanFeatureInputs(dto.features);
    await this.dataSource.transaction(async (manager) => {
      await this.savePlanFeatures(
        normalizedCode,
        normalizedFeatures,
        manager.getRepository(PlanFeatureEntity),
      );
    });
    const plan = await this.requirePlan(normalizedCode);
    return (await this.mapPlansWithFeatures([plan]))[0];
  }

  async updatePlanFeature(
    code: string,
    featureKeyInput: string,
    dto: UpdateAdminPlanFeatureDto,
  ) {
    const normalizedCode = normalizePlanCode(code);
    const featureKey = normalizeFeatureKey(featureKeyInput);
    const plan = await this.requirePlan(normalizedCode);
    const existing = await this.features.findOne({
      where: { planCode: normalizedCode, featureKey },
    });
    const period = resolveFeaturePeriod(featureKey, dto.period, existing?.period);
    const row = existing
      ? {
          ...existing,
          limitValue: dto.limitValue,
          period,
        }
      : this.features.create({
          planCode: normalizedCode,
          featureKey,
          limitValue: dto.limitValue,
          period,
        });

    await this.features.save(row);
    return (await this.mapPlansWithFeatures([plan]))[0];
  }

  async listOrders(query: AdminListOrdersQueryDto = {}) {
    const { page, limit, skip } = pagination(query.page, query.limit);
    const where: FindOptionsWhere<PaymentOrderEntity> = {};
    if (query.status) where.status = query.status;
    if (query.purpose) where.purpose = query.purpose;
    if (query.userId) where.userId = query.userId;

    const [items, total] = await this.orders.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return {
      page,
      limit,
      total,
      items: items.map((order) => ({
        id: order.id,
        userId: order.userId,
        orderCode: Number(order.orderCode),
        purpose: order.purpose,
        status: order.status,
        amountVnd: order.amountVnd,
        currency: order.currency,
        planCode: order.planCode,
        targetType: order.targetType,
        targetId: order.targetId,
        checkoutUrl: order.checkoutUrl,
        paymentLinkId: order.paymentLinkId,
        paidAt: order.paidAt?.toISOString() ?? null,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt?.toISOString() ?? null,
      })),
    };
  }

  async listSubscriptions(query: AdminListSubscriptionsQueryDto = {}) {
    const { page, limit, skip } = pagination(query.page, query.limit);
    const where: FindOptionsWhere<UserSubscriptionEntity> = {};
    if (query.status) where.status = query.status;
    if (query.planCode) where.planCode = normalizePlanCode(query.planCode);
    if (query.userId) where.userId = query.userId;

    const [items, total] = await this.subscriptions.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return {
      page,
      limit,
      total,
      items: items.map((subscription) => ({
        id: subscription.id,
        userId: subscription.userId,
        planCode: subscription.planCode,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart.toISOString(),
        currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
        sourcePaymentOrderId: subscription.sourcePaymentOrderId,
        createdAt: subscription.createdAt.toISOString(),
        updatedAt: subscription.updatedAt?.toISOString() ?? null,
      })),
    };
  }

  async listMentorBookings(query: AdminListMentorBookingsQueryDto = {}) {
    const { page, limit, skip } = pagination(query.page, query.limit);
    const where: FindOptionsWhere<MentorBookingEntity> = {};
    if (query.status) where.status = query.status;
    if (query.studentId) where.studentId = query.studentId;
    if (query.mentorId) where.mentorId = query.mentorId;

    const [items, total] = await this.mentorBookings.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return {
      page,
      limit,
      total,
      items: items.map((booking) => ({
        id: booking.id,
        studentId: booking.studentId,
        mentorId: booking.mentorId,
        planCode: booking.planCode,
        status: booking.status,
        slotStart: booking.slotStart?.toISOString() ?? null,
        slotEnd: booking.slotEnd?.toISOString() ?? null,
        totalAmountVnd: booking.totalAmountVnd,
        depositAmountVnd: booking.depositAmountVnd,
        remainingAmountVnd: booking.remainingAmountVnd,
        depositPaymentOrderId: booking.depositPaymentOrderId,
        remainingPaymentOrderId: booking.remainingPaymentOrderId,
        acceptedAt: booking.acceptedAt?.toISOString() ?? null,
        mentorProfileId: booking.mentorProfileId,
        availabilitySlotId: booking.availabilitySlotId,
        remainingDueAt: booking.remainingDueAt?.toISOString() ?? null,
        meetingUrl: booking.meetingUrl,
        completedAt: booking.completedAt?.toISOString() ?? null,
        cancelledAt: booking.cancelledAt?.toISOString() ?? null,
        cancelledBy: booking.cancelledBy,
        cancellationReason: booking.cancellationReason,
        refundStatus: booking.refundStatus,
        refundNote: booking.refundNote,
        createdAt: booking.createdAt.toISOString(),
        updatedAt: booking.updatedAt?.toISOString() ?? null,
      })),
    };
  }

  async updateMentorBookingRefund(bookingId: string, dto: UpdateAdminMentorBookingRefundDto) {
    const booking = await this.mentorBookings.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Mentor booking not found');
    if (booking.refundStatus !== 'PENDING') {
      throw new BadRequestException('Mentor booking is not pending refund review');
    }
    booking.refundStatus = dto.status;
    booking.refundNote = dto.note.trim();
    const saved = await this.mentorBookings.save(booking);
    return {
      id: saved.id,
      status: saved.status,
      refundStatus: saved.refundStatus,
      refundNote: saved.refundNote,
      updatedAt: saved.updatedAt?.toISOString?.() ?? null,
    };
  }

  private async savePlanFeatures(
    code: string,
    planFeatures: NormalizedPlanFeatureInput[],
    features: Repository<PlanFeatureEntity> = this.features,
  ): Promise<void> {
    await features.delete({ planCode: code });
    const rows = planFeatures.map((feature) =>
      features.create({
        planCode: code,
        featureKey: feature.featureKey,
        limitValue: feature.limitValue,
        period: feature.period,
      }),
    );
    if (rows.length > 0) {
      await features.save(rows);
    }
  }

  private async requirePlan(code: string): Promise<BillingPlanEntity> {
    const plan = await this.plans.findOne({ where: { code: normalizePlanCode(code) } });
    if (!plan) throw new NotFoundException('Billing plan not found');
    return plan;
  }

  private async mapPlansWithFeatures(plans: BillingPlanEntity[]) {
    if (plans.length === 0) return [];
    const planCodes = new Set(plans.map((plan) => plan.code));
    const allFeatures = await this.features.find();
    const featuresByPlan = new Map<string, PlanFeatureEntity[]>();
    for (const feature of allFeatures) {
      if (!planCodes.has(feature.planCode)) continue;
      const current = featuresByPlan.get(feature.planCode) ?? [];
      current.push(feature);
      featuresByPlan.set(feature.planCode, current);
    }

    return plans.map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      category: plan.category,
      interval: plan.interval,
      priceVnd: plan.priceVnd,
      currency: plan.currency,
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
      metadata: plan.metadata,
      features: (featuresByPlan.get(plan.code) ?? []).map((feature) => ({
        id: feature.id,
        featureKey: feature.featureKey,
        limitValue: feature.limitValue,
        period: feature.period,
      })),
      createdAt: plan.createdAt?.toISOString?.() ?? null,
      updatedAt: plan.updatedAt?.toISOString?.() ?? null,
    }));
  }
}

function normalizePlanCode(code: string): string {
  return code.trim().toUpperCase();
}

function pagination(pageInput = 1, limitInput = 20) {
  const page = Math.max(Number(pageInput) || 1, 1);
  const limit = Math.min(Math.max(Number(limitInput) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function assertNoDuplicateFeatureKeys(features: Array<{ featureKey: string }>): void {
  const seen = new Set<string>();
  for (const feature of features) {
    if (seen.has(feature.featureKey)) {
      throw new BadRequestException(`Duplicate featureKey: ${feature.featureKey}`);
    }
    seen.add(feature.featureKey);
  }
}

function normalizeFeatureKey(featureKey: string): BillingFeatureKey {
  const normalized = featureKey.trim() as BillingFeatureKey;
  getCatalogFeature(normalized);
  return normalized;
}

function normalizePlanFeatureInputs(
  features: Array<{ featureKey: string; limitValue: number; period?: BillingFeaturePeriod }>,
): NormalizedPlanFeatureInput[] {
  return features.map((feature) => {
    const featureKey = normalizeFeatureKey(feature.featureKey);
    return {
      featureKey,
      limitValue: feature.limitValue,
      period: resolveFeaturePeriod(featureKey, feature.period),
    };
  });
}

function resolveFeaturePeriod(
  featureKey: BillingFeatureKey,
  requestedPeriod?: BillingFeaturePeriod,
  existingPeriod?: BillingFeaturePeriod,
): BillingFeaturePeriod {
  if (requestedPeriod !== undefined) {
    assertFeaturePeriodAllowed(featureKey, requestedPeriod);
    return requestedPeriod;
  }
  if (existingPeriod && isFeaturePeriodAllowed(featureKey, existingPeriod)) {
    return existingPeriod;
  }
  assertFeaturePeriodAllowed(featureKey, DEFAULT_BILLING_FEATURE_PERIOD);
  return DEFAULT_BILLING_FEATURE_PERIOD;
}

function assertFeaturePeriodAllowed(
  featureKey: BillingFeatureKey,
  period: BillingFeaturePeriod,
): void {
  if (!isFeaturePeriodAllowed(featureKey, period)) {
    throw new BadRequestException(`Unsupported period ${period} for featureKey: ${featureKey}`);
  }
}

function isFeaturePeriodAllowed(
  featureKey: BillingFeatureKey,
  period: BillingFeaturePeriod,
): boolean {
  return getCatalogFeature(featureKey).allowedPeriods.includes(period);
}

function getCatalogFeature(featureKey: BillingFeatureKey) {
  const feature = BILLING_FEATURE_CATALOG.find((item) => item.featureKey === featureKey);
  if (!feature) {
    throw new BadRequestException(`Unsupported featureKey: ${featureKey}`);
  }
  return feature;
}
