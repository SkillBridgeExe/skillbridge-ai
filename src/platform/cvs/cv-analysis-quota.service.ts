import { Injectable } from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service';

const CV_REVIEW_FEATURE = 'cv_review';

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
    await this.entitlements.assertCanUse(userId, CV_REVIEW_FEATURE);
  }

  async recordSuccessfulAnalysis(userId: string, cvId: string): Promise<void> {
    if (!userId) return;
    await this.entitlements.recordUsage(userId, CV_REVIEW_FEATURE, {
      sourceType: 'cv',
      sourceId: cvId,
    });
  }
}
