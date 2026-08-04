import { HttpException, HttpStatus } from '@nestjs/common';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { CreditAwareUsageService } from './credit-aware-usage.service';
import { CreditBalanceService } from './credit-balance.service';
import { EntitlementsService, UsageReservation } from './entitlements.service';

function planReservation(): UsageReservation {
  return {
    eventId: 'usage-1',
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
}

function quotaError(): HttpException {
  return new HttpException(
    { errorCode: ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

describe('CreditAwareUsageService', () => {
  function setup() {
    const entitlements = {
      reserveUsage: jest.fn(),
    } as unknown as jest.Mocked<EntitlementsService>;
    const credits = {
      reserve: jest.fn(),
    } as unknown as jest.Mocked<CreditBalanceService>;
    return {
      service: new CreditAwareUsageService(entitlements, credits),
      entitlements,
      credits,
    };
  }

  it('labels a monthly quota reservation as PLAN without touching credits', async () => {
    const { service, entitlements, credits } = setup();
    entitlements.reserveUsage.mockResolvedValue(planReservation());

    const reservation = await service.reservePlanFirst('user-1', BillingFeatureKey.CV_REVIEW);

    expect(reservation.source).toBe('PLAN');
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('falls back to a purchased credit after monthly quota is exhausted', async () => {
    const { service, entitlements, credits } = setup();
    entitlements.reserveUsage.mockRejectedValue(quotaError());
    credits.reserve.mockResolvedValue({
      reservationId: 'credit-1',
      confirm: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    });

    const reservation = await service.reservePlanFirst('user-1', BillingFeatureKey.CV_REVIEW);

    expect(reservation.source).toBe('CREDIT');
    expect(credits.reserve).toHaveBeenCalledWith('user-1', 'CV_ANALYSIS');
  });

  it('reserves a credit directly when it must replace upload quota too', async () => {
    const { service, entitlements, credits } = setup();
    credits.reserve.mockResolvedValue({
      reservationId: 'credit-1',
      confirm: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    });

    const reservation = await service.reserveCreditOnly('user-1', BillingFeatureKey.CV_REVIEW);

    expect(reservation.source).toBe('CREDIT');
    expect(entitlements.reserveUsage).not.toHaveBeenCalled();
  });

  it('returns a purchase hint when neither plan quota nor credit is available', async () => {
    const { service, entitlements, credits } = setup();
    entitlements.reserveUsage.mockRejectedValue(quotaError());
    credits.reserve.mockResolvedValue(null);

    await expect(
      service.reservePlanFirst('user-1', BillingFeatureKey.CV_REVIEW),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ creditType: 'CV_ANALYSIS' }),
      status: HttpStatus.PAYMENT_REQUIRED,
    });
  });
});
