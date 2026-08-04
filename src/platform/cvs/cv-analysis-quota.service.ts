import { HttpException, Injectable } from '@nestjs/common';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import {
  CreditAwareReservation,
  CreditAwareUsageService,
} from '../billing/credit-aware-usage.service';
import { UsageReservation } from '../billing/entitlements.service';
import { EntitlementsService } from '../billing/entitlements.service';

export interface CvUploadUsageReservations {
  upload: UsageReservation | null;
  analysis: CreditAwareReservation | null;
  creditCoversUpload: boolean;
}

/**
 * Billing-aware quota gate for CV analysis.
 *
 * Kept as a small adapter so CvsService can still check before storing uploaded files, while the
 * actual limits now come from billing plan features instead of a hard-coded env limit.
 */
@Injectable()
export class CvAnalysisQuotaService {
  constructor(
    private readonly usage: CreditAwareUsageService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Atomically charge one cv_review use (race-free reserve). Returns null for anonymous internal
   * callers (no user = no quota). Caller must `refund()` on failure and `confirm()` with the cv id.
   */
  async reserveAnalysis(userId: string): Promise<CreditAwareReservation | null> {
    if (!userId) return null;
    return this.usage.reservePlanFirst(userId, BillingFeatureKey.CV_REVIEW);
  }

  async reserveMatch(userId: string): Promise<CreditAwareReservation> {
    const planCode = await this.entitlements.getPlanCode(userId);
    const featureKey =
      planCode === 'FREE' || planCode === 'PREMIUM'
        ? BillingFeatureKey.CV_REVIEW
        : BillingFeatureKey.CV_JD_MATCH;
    return this.usage.reservePlanFirst(userId, featureKey);
  }

  async reserveForUpload(userId: string): Promise<CvUploadUsageReservations> {
    let upload: UsageReservation;
    try {
      upload = await this.entitlements.reserveUsage(userId, BillingFeatureKey.CV_UPLOAD);
    } catch (error) {
      if (!isQuotaUnavailable(error)) throw error;
      return {
        upload: null,
        analysis: await this.usage.reserveCreditOnly(userId, BillingFeatureKey.CV_REVIEW),
        creditCoversUpload: true,
      };
    }

    try {
      return {
        upload,
        analysis: await this.usage.reservePlanFirst(userId, BillingFeatureKey.CV_REVIEW),
        creditCoversUpload: false,
      };
    } catch (error) {
      if (!isQuotaUnavailable(error)) {
        await upload.refund();
        throw error;
      }
      return { upload, analysis: null, creditCoversUpload: false };
    }
  }
}

function isQuotaUnavailable(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const response = error.getResponse();
  if (!response || typeof response !== 'object') return false;
  const errorCode = (response as { errorCode?: unknown }).errorCode;
  return (
    errorCode === ERROR_CODES.FEATURE_NOT_INCLUDED ||
    errorCode === ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED
  );
}
