import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
} from '../../../common/constants/billing.constants';
import { AdminBillingPlanFeatureInputDto } from './admin-billing.dto';

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
