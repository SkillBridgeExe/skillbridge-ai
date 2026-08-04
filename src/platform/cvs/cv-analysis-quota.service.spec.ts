import { HttpException, HttpStatus } from '@nestjs/common';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import {
  CreditAwareReservation,
  CreditAwareUsageService,
} from '../billing/credit-aware-usage.service';
import { EntitlementsService, UsageReservation } from '../billing/entitlements.service';
import { CvAnalysisQuotaService } from './cv-analysis-quota.service';

function planUsage(): UsageReservation {
  return {
    eventId: 'upload-usage-1',
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
}

function analysisUsage(source: 'PLAN' | 'CREDIT'): CreditAwareReservation {
  return {
    source,
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
}

function unavailable(featureNotIncluded = false): HttpException {
  return new HttpException(
    {
      errorCode: featureNotIncluded
        ? ERROR_CODES.FEATURE_NOT_INCLUDED
        : ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED,
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

describe('CvAnalysisQuotaService', () => {
  function setup() {
    const usage = {
      reservePlanFirst: jest.fn(),
      reserveCreditOnly: jest.fn(),
    } as unknown as jest.Mocked<CreditAwareUsageService>;
    const entitlements = {
      reserveUsage: jest.fn(),
    } as unknown as jest.Mocked<EntitlementsService>;
    return {
      service: new CvAnalysisQuotaService(usage, entitlements),
      usage,
      entitlements,
    };
  }

  it('uses upload quota and then the normal plan-first analysis source', async () => {
    const { service, usage, entitlements } = setup();
    const upload = planUsage();
    const analysis = analysisUsage('PLAN');
    entitlements.reserveUsage.mockResolvedValue(upload);
    usage.reservePlanFirst.mockResolvedValue(analysis);

    const result = await service.reserveForUpload('user-1');

    expect(result).toEqual({ upload, analysis, creditCoversUpload: false });
    expect(entitlements.reserveUsage).toHaveBeenCalledWith('user-1', BillingFeatureKey.CV_UPLOAD);
  });

  it('uses a CV credit directly when monthly upload quota is exhausted', async () => {
    const { service, usage, entitlements } = setup();
    const analysis = analysisUsage('CREDIT');
    entitlements.reserveUsage.mockRejectedValue(unavailable());
    usage.reserveCreditOnly.mockResolvedValue(analysis);

    const result = await service.reserveForUpload('user-1');

    expect(result).toEqual({ upload: null, analysis, creditCoversUpload: true });
    expect(usage.reservePlanFirst).not.toHaveBeenCalled();
  });

  it('keeps the upload reservation and allows an uploaded-only result when analysis is exhausted', async () => {
    const { service, usage, entitlements } = setup();
    const upload = planUsage();
    entitlements.reserveUsage.mockResolvedValue(upload);
    usage.reservePlanFirst.mockRejectedValue(unavailable(true));

    const result = await service.reserveForUpload('user-1');

    expect(result).toEqual({ upload, analysis: null, creditCoversUpload: false });
  });
});
