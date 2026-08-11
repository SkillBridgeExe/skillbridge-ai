import { AdminBillingService } from './admin-billing.service';
import { AdminBillingController } from './admin-billing.controller';
import { AdminVoucherService } from './admin-voucher.service';
import {
  AdminFeatureUsagePeriod,
  AdminFeatureUsageQueryDto,
  AdminReconcilePaymentOrdersDto,
} from './dto/admin-billing.dto';
import { AdminPaymentReconciliationService } from './admin-payment-reconciliation.service';

describe('AdminBillingController', () => {
  it('forwards the feature usage period to the billing service', async () => {
    const response = {
      period: AdminFeatureUsagePeriod.ALL_TIME,
      items: [{ featureKey: 'cv_review', uniqueUserCount: 7 }],
    };
    const billing = {
      listFeatureUsage: jest.fn().mockResolvedValue(response),
    } as unknown as AdminBillingService;
    const controller = new AdminBillingController(
      billing,
      {} as AdminVoucherService,
      {} as AdminPaymentReconciliationService,
    );
    const query: AdminFeatureUsageQueryDto = {
      period: AdminFeatureUsagePeriod.ALL_TIME,
    };

    await expect(controller.listFeatureUsage(query)).resolves.toBe(response);
    expect(billing.listFeatureUsage).toHaveBeenCalledWith(query);
  });

  it('forwards the Admin reconciliation window to the reconciliation service', async () => {
    const billing = {} as AdminBillingService;
    const reconciliation = {
      reconcile: jest.fn().mockResolvedValue({ settled: 1 }),
    } as unknown as AdminPaymentReconciliationService;
    const controller = new AdminBillingController(
      billing,
      {} as AdminVoucherService,
      reconciliation,
    );
    const dto: AdminReconcilePaymentOrdersDto = {
      period: 'THIS_YEAR',
    };

    await expect(controller.reconcileOrders(dto)).resolves.toEqual({ settled: 1 });
    expect(reconciliation.reconcile).toHaveBeenCalledWith(dto);
  });
});
