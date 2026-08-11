import { AdminBillingService } from './admin-billing.service';
import { AdminBillingController } from './admin-billing.controller';
import { AdminVoucherService } from './admin-voucher.service';
import { AdminFeatureUsagePeriod, AdminFeatureUsageQueryDto } from './dto/admin-billing.dto';

describe('AdminBillingController', () => {
  it('forwards the feature usage period to the billing service', async () => {
    const response = {
      period: AdminFeatureUsagePeriod.ALL_TIME,
      items: [{ featureKey: 'cv_review', uniqueUserCount: 7 }],
    };
    const billing = {
      listFeatureUsage: jest.fn().mockResolvedValue(response),
    } as unknown as AdminBillingService;
    const controller = new AdminBillingController(billing, {} as AdminVoucherService);
    const query: AdminFeatureUsageQueryDto = {
      period: AdminFeatureUsagePeriod.ALL_TIME,
    };

    await expect(controller.listFeatureUsage(query)).resolves.toBe(response);
    expect(billing.listFeatureUsage).toHaveBeenCalledWith(query);
  });
});
