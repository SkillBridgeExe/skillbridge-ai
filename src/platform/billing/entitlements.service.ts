import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { BillingFeatureKey } from '../../database/entities/plan-feature.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { UsageEventEntity } from '../../database/entities/usage-event.entity';
import { UserSubscriptionEntity } from '../../database/entities/user-subscription.entity';
import { EntitlementFeatureDto, SubscriptionResponseDto } from './dto/billing.dto';

const FREE_PLAN_CODE = 'FREE';

@Injectable()
export class EntitlementsService {
  constructor(
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    @InjectRepository(PlanFeatureEntity) private readonly features: Repository<PlanFeatureEntity>,
    @InjectRepository(UserSubscriptionEntity)
    private readonly subscriptions: Repository<UserSubscriptionEntity>,
    @InjectRepository(UsageEventEntity) private readonly usageEvents: Repository<UsageEventEntity>,
  ) {}

  async assertCanUse(userId: string, featureKey: BillingFeatureKey): Promise<void> {
    const entitlement = await this.getCurrentEntitlements(userId);
    const feature = entitlement.features.find((item) => item.featureKey === featureKey);
    if (!feature || !feature.allowed) {
      const limit = feature?.limit ?? 0;
      throw new HttpException(
        {
          errorCode:
            limit === 0
              ? ERROR_CODES.FEATURE_NOT_INCLUDED
              : ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED,
          message:
            limit === 0
              ? 'Your current plan does not include this feature.'
              : 'You have used all quota for this feature in the current period.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  async recordUsage(
    userId: string,
    featureKey: BillingFeatureKey,
    source?: { sourceType?: string; sourceId?: string },
  ): Promise<void> {
    const subscription = await this.findActiveSubscription(userId);
    await this.usageEvents.save(
      this.usageEvents.create({
        userId,
        featureKey,
        subscriptionId: subscription?.id ?? null,
        sourceType: source?.sourceType ?? null,
        sourceId: source?.sourceId ?? null,
      }),
    );
  }

  async getCurrentEntitlements(userId: string): Promise<SubscriptionResponseDto> {
    const subscription = await this.findActiveSubscription(userId);
    const planCode = subscription?.planCode ?? FREE_PLAN_CODE;
    const plan = await this.plans.findOne({ where: { code: planCode, isActive: true } });
    const currentPeriodStart = subscription?.currentPeriodStart ?? startOfCurrentMonthIct();
    const currentPeriodEnd = subscription?.currentPeriodEnd ?? addMonths(currentPeriodStart, 1);
    const features = await this.features.find({ where: { planCode } });
    const usage = await this.countUsage(userId, currentPeriodStart, currentPeriodEnd);

    return {
      planCode: plan?.code ?? FREE_PLAN_CODE,
      status: subscription?.status ?? 'FREE',
      currentPeriodStart: currentPeriodStart.toISOString(),
      currentPeriodEnd: currentPeriodEnd.toISOString(),
      features: features.map((feature) =>
        this.toFeatureDto(feature, usage.get(feature.featureKey) ?? 0),
      ),
    };
  }

  async listUsage(userId: string): Promise<SubscriptionResponseDto> {
    return this.getCurrentEntitlements(userId);
  }

  private async findActiveSubscription(userId: string): Promise<UserSubscriptionEntity | null> {
    return this.subscriptions.findOne({
      where: {
        userId,
        status: 'ACTIVE',
        currentPeriodStart: LessThanOrEqual(new Date()),
        currentPeriodEnd: MoreThan(new Date()),
      },
      order: { updatedAt: 'DESC' },
    });
  }

  private async countUsage(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.usageEvents
      .createQueryBuilder('usage')
      .select('usage.feature_key', 'featureKey')
      .addSelect('COUNT(*)', 'count')
      .where('usage.user_id = :userId', { userId })
      .andWhere('usage.used_at >= :periodStart', { periodStart })
      .andWhere('usage.used_at < :periodEnd', { periodEnd })
      .groupBy('usage.feature_key')
      .getRawMany<{ featureKey: string; count: string }>();
    return new Map(rows.map((row) => [row.featureKey, Number(row.count)]));
  }

  private toFeatureDto(feature: PlanFeatureEntity, used: number): EntitlementFeatureDto {
    const unlimited = feature.limitValue === -1;
    const remaining = unlimited ? null : Math.max(feature.limitValue - used, 0);
    return {
      featureKey: feature.featureKey,
      limit: feature.limitValue,
      used,
      remaining,
      unlimited,
      allowed: unlimited || feature.limitValue > used,
    };
  }
}

function startOfCurrentMonthIct(): Date {
  const ict = new Date(Date.now() + 7 * 60 * 60 * 1000);
  ict.setUTCDate(1);
  ict.setUTCHours(0, 0, 0, 0);
  return new Date(ict.getTime() - 7 * 60 * 60 * 1000);
}

export function addMonths(date: Date, count: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + count);
  return next;
}
