import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
} from '../../../common/constants/billing.constants';
import {
  AdminBillingPlanFeatureInputDto,
  CreateAdminVoucherDto,
  AdminFeatureUsagePeriod,
  AdminFeatureUsageQueryDto,
  AdminReconcilePaymentOrdersDto,
  UpdateAdminPlanFeatureDto,
} from './admin-billing.dto';

describe('AdminBillingPlanFeatureInputDto', () => {
  it('accepts daily feature periods', async () => {
    const dto = plainToInstance(AdminBillingPlanFeatureInputDto, {
      featureKey: BillingFeatureKey.CV_REVIEW,
      limitValue: 5,
      period: BillingFeaturePeriod.DAILY,
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});

describe('UpdateAdminPlanFeatureDto', () => {
  it('accepts a single feature limit update', async () => {
    const dto = plainToInstance(UpdateAdminPlanFeatureDto, {
      limitValue: 20,
      period: BillingFeaturePeriod.MONTHLY,
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects a limit below the unlimited sentinel', async () => {
    const dto = plainToInstance(UpdateAdminPlanFeatureDto, {
      limitValue: -2,
      period: BillingFeaturePeriod.MONTHLY,
    });

    const errors = await validate(dto);

    expect(errors).toEqual([expect.objectContaining({ property: 'limitValue' })]);
  });
});

describe('AdminFeatureUsageQueryDto', () => {
  it('defaults to the current month', async () => {
    const dto = plainToInstance(AdminFeatureUsageQueryDto, {});

    expect(dto.period).toBe(AdminFeatureUsagePeriod.THIS_MONTH);
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects an unsupported usage period', async () => {
    const dto = plainToInstance(AdminFeatureUsageQueryDto, { period: 'LAST_WEEK' });

    const errors = await validate(dto);

    expect(errors).toEqual([expect.objectContaining({ property: 'period' })]);
  });

  it('accepts all recorded history', async () => {
    const dto = plainToInstance(AdminFeatureUsageQueryDto, {
      period: AdminFeatureUsagePeriod.ALL_TIME,
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});

describe('AdminReconcilePaymentOrdersDto', () => {
  it('accepts a calendar period and ICT custom dates', async () => {
    const dto = plainToInstance(AdminReconcilePaymentOrdersDto, {
      period: 'CUSTOM',
      from: '2026-08-01',
      to: '2026-08-11',
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects an unsupported period or malformed date format', async () => {
    const dto = plainToInstance(AdminReconcilePaymentOrdersDto, {
      period: 'LAST_WEEK',
      from: '08/01/2026',
      to: '2026-08-11',
    });

    const errors = await validate(dto);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'period' }),
        expect.objectContaining({ property: 'from' }),
      ]),
    );
  });
});

describe('CreateAdminVoucherDto', () => {
  const period = {
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-09-01T00:00:00.000Z',
    maxRedemptions: 100,
  };

  it('accepts a configured credit reward without discount fields', async () => {
    const dto = plainToInstance(CreateAdminVoucherDto, {
      code: 'FREECV3',
      benefitType: 'CREDIT_GRANT',
      creditType: 'CV_ANALYSIS',
      creditUnits: 3,
      ...period,
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects a credit voucher without a positive credit unit count', async () => {
    const dto = plainToInstance(CreateAdminVoucherDto, {
      code: 'FREECV',
      benefitType: 'CREDIT_GRANT',
      creditType: 'CV_ANALYSIS',
      ...period,
    });

    const errors = await validate(dto);

    expect(errors).toEqual([expect.objectContaining({ property: 'creditUnits' })]);
  });
});
