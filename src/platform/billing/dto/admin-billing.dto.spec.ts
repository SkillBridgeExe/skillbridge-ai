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
