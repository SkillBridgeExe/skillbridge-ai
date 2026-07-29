import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  And,
  DataSource,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
  BillingPlanCode,
  UNLIMITED_BILLING_LIMIT,
} from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { UsageEventEntity } from '../../database/entities/usage-event.entity';
import { UserSubscriptionEntity } from '../../database/entities/user-subscription.entity';
import { EntitlementFeatureDto, SubscriptionResponseDto } from './dto/billing.dto';

/**
 * A charged usage slot returned by `reserveUsage`. The charge already exists in `usage_events`;
 * the flow that reserved it must either let it stand (value delivered), `confirm()` to attach the
 * produced artifact id, or `refund()` when the flow failed / delivered no value.
 */
export interface UsageReservation {
  eventId: string;
  /** Attach the delivered artifact (e.g. the created match id) to the charged event. Never throws. */
  confirm(source: { sourceType?: string; sourceId?: string }): Promise<void>;
  /** Delete the reserved charge — call on failure or a no-value result. Idempotent, never throws. */
  refund(): Promise<void>;
}

@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    @InjectRepository(BillingPlanEntity) private readonly plans: Repository<BillingPlanEntity>,
    @InjectRepository(PlanFeatureEntity) private readonly features: Repository<PlanFeatureEntity>,
    @InjectRepository(UserSubscriptionEntity)
    private readonly subscriptions: Repository<UserSubscriptionEntity>,
    @InjectRepository(UsageEventEntity) private readonly usageEvents: Repository<UsageEventEntity>,
    // Optional for unit tests that construct the service without a DB (reserveUsage requires it).
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
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

  async assertFeatureIncluded(userId: string, featureKey: BillingFeatureKey): Promise<void> {
    const subscription = await this.findActiveSubscription(userId);
    const planCode = subscription?.planCode ?? BillingPlanCode.FREE;
    const feature = await this.features.findOne({ where: { planCode, featureKey } });
    if (!feature || feature.limitValue === 0) {
      throw new HttpException(
        {
          errorCode: ERROR_CODES.FEATURE_NOT_INCLUDED,
          message: 'This feature is not included in your current plan.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  async getPlanCode(userId: string): Promise<string> {
    return (await this.findActiveSubscription(userId))?.planCode ?? BillingPlanCode.FREE;
  }

  /**
   * Atomic check-and-charge for one usage of `featureKey`. The count + insert run in ONE
   * transaction serialized per
   * (user, feature) by a pg advisory xact lock, so concurrent requests at `limit-1` queue and the
   * loser sees the winner's row (402 instead of a silent overrun).
   *
   * Charge-first semantics: the usage row exists from this point on. Callers MUST `refund()` on
   * failure or a no-value result so the "charge only for delivered value" norm is preserved, and
   * may `confirm()` to attach the produced artifact id once it is known.
   */
  async reserveUsage(
    userId: string,
    featureKey: BillingFeatureKey,
    source?: { sourceType?: string; sourceId?: string },
  ): Promise<UsageReservation> {
    if (!this.dataSource)
      throw new Error('EntitlementsService requires a DataSource for reserveUsage');
    const subscription = await this.findActiveSubscription(userId);
    const planCode = subscription?.planCode ?? BillingPlanCode.FREE;
    const feature = await this.features.findOne({ where: { planCode, featureKey } });
    if (!feature || feature.limitValue === 0) {
      throw new HttpException(
        {
          errorCode: ERROR_CODES.FEATURE_NOT_INCLUDED,
          message: 'Your current plan does not include this feature.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const unlimited = feature.limitValue === UNLIMITED_BILLING_LIMIT;
    const currentPeriodStart = subscription?.currentPeriodStart ?? startOfCurrentMonthIct();
    const currentPeriodEnd = subscription?.currentPeriodEnd ?? addMonths(currentPeriodStart, 1);
    const window = this.featureWindow(feature.period, currentPeriodStart, currentPeriodEnd);

    const event = await this.dataSource.transaction(async (manager) => {
      if (!unlimited) {
        // Serialize concurrent reserves for the same (user, feature); released at commit/rollback.
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `usage:${userId}:${featureKey}`,
        ]);
        const used = await manager.count(UsageEventEntity, {
          where: {
            userId,
            featureKey,
            usedAt: And(MoreThanOrEqual(window.periodStart), LessThan(window.periodEnd)),
          },
        });
        if (used >= feature.limitValue) {
          throw new HttpException(
            {
              errorCode: ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED,
              message: 'You have used all quota for this feature in the current period.',
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
      }
      return manager.save(
        manager.create(UsageEventEntity, {
          userId,
          featureKey,
          subscriptionId: subscription?.id ?? null,
          sourceType: source?.sourceType ?? null,
          sourceId: source?.sourceId ?? null,
        }),
      );
    });

    // confirm/refund are best-effort and never throw: a metadata update (or refund) failure must
    // not mask the flow's own result/error. A failed refund means one over-charged event — log it.
    return {
      eventId: event.id,
      confirm: async (s) => {
        try {
          await this.usageEvents.update(event.id, {
            sourceType: s.sourceType ?? null,
            sourceId: s.sourceId ?? null,
          });
        } catch (error) {
          this.logger.warn(`confirm(${event.id}) failed: ${(error as Error).message}`);
        }
      },
      refund: async () => {
        try {
          await this.usageEvents.delete(event.id);
        } catch (error) {
          this.logger.warn(
            `refund(${event.id}) failed — user ${userId} over-charged for ${featureKey}: ${(error as Error).message}`,
          );
        }
      },
    };
  }

  async getCurrentEntitlements(userId: string): Promise<SubscriptionResponseDto> {
    const subscription = await this.findActiveSubscription(userId);
    const planCode = subscription?.planCode ?? BillingPlanCode.FREE;
    const plan = await this.plans.findOne({ where: { code: planCode } });
    const currentPeriodStart = subscription?.currentPeriodStart ?? startOfCurrentMonthIct();
    const currentPeriodEnd = subscription?.currentPeriodEnd ?? addMonths(currentPeriodStart, 1);
    const features = await this.features.find({ where: { planCode } });
    const usageByFeature = new Map<string, { used: number; resetsAt: Date }>();
    for (const feature of features) {
      const window = this.featureWindow(feature.period, currentPeriodStart, currentPeriodEnd);
      const used = await this.countFeatureUsage(
        userId,
        feature.featureKey,
        window.periodStart,
        window.periodEnd,
      );
      usageByFeature.set(feature.featureKey, { used, resetsAt: window.periodEnd });
    }

    return {
      planCode: subscription?.planCode ?? plan?.code ?? BillingPlanCode.FREE,
      status: subscription?.status ?? BillingPlanCode.FREE,
      currentPeriodStart: currentPeriodStart.toISOString(),
      currentPeriodEnd: currentPeriodEnd.toISOString(),
      features: features.map((feature) => {
        const usage = usageByFeature.get(feature.featureKey);
        return this.toFeatureDto(feature, usage?.used ?? 0, usage?.resetsAt ?? currentPeriodEnd);
      }),
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

  private async countFeatureUsage(
    userId: string,
    featureKey: BillingFeatureKey,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    const rows = await this.usageEvents
      .createQueryBuilder('usage')
      .select('usage.feature_key', 'featureKey')
      .addSelect('COUNT(*)', 'count')
      .where('usage.user_id = :userId', { userId })
      .andWhere('usage.feature_key = :featureKey', { featureKey })
      .andWhere('usage.used_at >= :periodStart', { periodStart })
      .andWhere('usage.used_at < :periodEnd', { periodEnd })
      .groupBy('usage.feature_key')
      .getRawMany<{ featureKey: string; count: string }>();
    return Number(rows[0]?.count ?? 0);
  }

  private featureWindow(
    period: BillingFeaturePeriod,
    monthlyPeriodStart: Date,
    monthlyPeriodEnd: Date,
  ): { periodStart: Date; periodEnd: Date } {
    if (period === BillingFeaturePeriod.DAILY) {
      const periodStart = startOfCurrentDayIct();
      return { periodStart, periodEnd: addDays(periodStart, 1) };
    }
    return { periodStart: monthlyPeriodStart, periodEnd: monthlyPeriodEnd };
  }

  private toFeatureDto(
    feature: PlanFeatureEntity,
    used: number,
    resetsAt: Date,
  ): EntitlementFeatureDto {
    const unlimited = feature.limitValue === UNLIMITED_BILLING_LIMIT;
    const remaining = unlimited ? null : Math.max(feature.limitValue - used, 0);
    return {
      featureKey: feature.featureKey,
      limit: feature.limitValue,
      period: feature.period,
      used,
      remaining,
      unlimited,
      allowed: unlimited || feature.limitValue > used,
      resetsAt: resetsAt.toISOString(),
    };
  }
}

function startOfCurrentDayIct(): Date {
  const ict = new Date(Date.now() + 7 * 60 * 60 * 1000);
  ict.setUTCHours(0, 0, 0, 0);
  return new Date(ict.getTime() - 7 * 60 * 60 * 1000);
}

function startOfCurrentMonthIct(): Date {
  const ict = new Date(Date.now() + 7 * 60 * 60 * 1000);
  ict.setUTCDate(1);
  ict.setUTCHours(0, 0, 0, 0);
  return new Date(ict.getTime() - 7 * 60 * 60 * 1000);
}

export function addMonths(date: Date, count: number): Date {
  const next = new Date(date);
  const originalDay = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + count);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return next;
}

function addDays(date: Date, count: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + count);
  return next;
}
