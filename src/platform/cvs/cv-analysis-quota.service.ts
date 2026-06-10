import { Injectable } from '@nestjs/common';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { EntitlementsService } from '../billing/entitlements.service';

/**
 * Billing-aware quota gate for CV analysis.
 *
 * Kept as a small adapter so CvsService can still check before storing uploaded files, while the
 * actual limits now come from billing plan features instead of a hard-coded env limit.
 */
@Injectable()
export class CvAnalysisQuotaService {
  constructor(private readonly entitlements: EntitlementsService) {}

  async assertWithinDailyLimit(userId: string): Promise<void> {
    if (!userId) return;
    await this.entitlements.assertCanUse(userId, BillingFeatureKey.CV_REVIEW);
  }

  async recordSuccessfulAnalysis(userId: string, cvId: string): Promise<void> {
    if (!userId) return;
    await this.entitlements.recordUsage(userId, BillingFeatureKey.CV_REVIEW, {
      sourceType: 'cv',
      sourceId: cvId,
    });
  }
}
