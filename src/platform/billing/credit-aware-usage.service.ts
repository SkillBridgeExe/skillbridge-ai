import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { CreditType } from '../../database/entities/billing-credit-package.entity';
import { CreditBalanceService } from './credit-balance.service';
import { EntitlementsService } from './entitlements.service';

export type UsageSource = 'PLAN' | 'CREDIT';

export interface CreditAwareReservation {
  source: UsageSource;
  confirm(source?: { sourceType?: string; sourceId?: string }): Promise<void>;
  refund(): Promise<void>;
}

@Injectable()
export class CreditAwareUsageService {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly credits: CreditBalanceService,
  ) {}

  async reservePlanFirst(
    userId: string,
    featureKey: BillingFeatureKey,
  ): Promise<CreditAwareReservation> {
    try {
      const reservation = await this.entitlements.reserveUsage(userId, featureKey);
      return {
        source: 'PLAN',
        confirm: (source = {}) => reservation.confirm(source),
        refund: () => reservation.refund(),
      };
    } catch (error) {
      if (!isQuotaUnavailable(error)) throw error;
      const creditType = creditTypeForFeature(featureKey);
      if (!creditType) throw error;
      return this.reserveCredit(userId, creditType);
    }
  }

  async reserveCreditOnly(
    userId: string,
    featureKey: BillingFeatureKey,
  ): Promise<CreditAwareReservation> {
    const creditType = creditTypeForFeature(featureKey);
    if (!creditType) {
      throw new HttpException(
        {
          errorCode: ERROR_CODES.FEATURE_NOT_INCLUDED,
          message: 'Purchased credits are not available for this feature.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return this.reserveCredit(userId, creditType);
  }

  private async reserveCredit(
    userId: string,
    creditType: CreditType,
  ): Promise<CreditAwareReservation> {
    const reservation = await this.credits.reserve(userId, creditType);
    if (reservation) {
      return {
        source: 'CREDIT',
        confirm: (source = {}) => reservation.confirm(source),
        refund: () => reservation.refund(),
      };
    }
    throw new HttpException(
      {
        errorCode: ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED,
        message: 'Your plan quota and purchased credits are exhausted.',
        creditType,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

export function creditTypeForFeature(featureKey: BillingFeatureKey): CreditType | null {
  if (featureKey === BillingFeatureKey.INTERVIEW_SESSION) return 'INTERVIEW_SESSION';
  if (featureKey === BillingFeatureKey.CV_REVIEW || featureKey === BillingFeatureKey.CV_JD_MATCH) {
    return 'CV_ANALYSIS';
  }
  return null;
}

function isQuotaUnavailable(error: unknown): boolean {
  if (!(error instanceof HttpException) || error.getStatus() !== HttpStatus.PAYMENT_REQUIRED) {
    return false;
  }
  const response = error.getResponse();
  return Boolean(
    response &&
    typeof response === 'object' &&
    [ERROR_CODES.FEATURE_NOT_INCLUDED, ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED].includes(
      (response as { errorCode?: string }).errorCode as never,
    ),
  );
}
