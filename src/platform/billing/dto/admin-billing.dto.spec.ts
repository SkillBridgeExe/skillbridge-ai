import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
} from '../../../common/constants/billing.constants';
import { AdminBillingPlanFeatureInputDto, UpdateAdminPlanFeatureDto } from './admin-billing.dto';

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
