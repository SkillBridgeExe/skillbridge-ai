import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { DEFAULT_BILLING_FEATURE_PERIOD } from '../../common/constants/billing.constants';
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
} from './dto/admin-billing.dto';

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
      await this.savePlanFeatures(code, { features: dto.features });
    }
    return (await this.mapPlansWithFeatures([plan]))[0];
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
    await this.savePlanFeatures(normalizedCode, dto);
    const plan = await this.requirePlan(normalizedCode);
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

  private async savePlanFeatures(code: string, dto: ReplaceAdminPlanFeaturesDto): Promise<void> {
    assertNoDuplicateFeatureKeys(dto.features);
    await this.features.delete({ planCode: code });
    const rows = dto.features.map((feature) =>
      this.features.create({
        planCode: code,
        featureKey: feature.featureKey,
        limitValue: feature.limitValue,
        period: feature.period ?? DEFAULT_BILLING_FEATURE_PERIOD,
      }),
    );
    if (rows.length > 0) {
      await this.features.save(rows);
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
