import { Injectable } from '@nestjs/common';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { EntitlementsService, UsageReservation } from '../billing/entitlements.service';

/**
 * Billing-aware quota gate for CV analysis.
 *
 * Kept as a small adapter so CvsService can still check before storing uploaded files, while the
 * actual limits now come from billing plan features instead of a hard-coded env limit.
 */
@Injectable()
export class CvAnalysisQuotaService {
  constructor(private readonly entitlements: EntitlementsService) {}

  /**
   * Atomically charge one cv_review use (race-free reserve). Returns null for anonymous internal
   * callers (no user = no quota). Caller must `refund()` on failure and `confirm()` with the cv id.
   */
  async reserveAnalysis(userId: string): Promise<UsageReservation | null> {
    if (!userId) return null;
    return this.entitlements.reserveUsage(userId, BillingFeatureKey.CV_REVIEW);
  }
}
