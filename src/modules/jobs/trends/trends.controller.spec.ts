import { HttpException } from '@nestjs/common';
import { BillingPlanCode } from '../../../common/constants/billing.constants';
import { TrendsController } from './trends.controller';

describe('TrendsController premium market gap', () => {
  const user = { userId: 'user-1' };
  const demand = { getSkillGap: jest.fn() };
  const insight = { generate: jest.fn() };
  const entitlements = { hasActivePlan: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a non-Premium user before loading personalized market gaps', async () => {
    entitlements.hasActivePlan.mockResolvedValue(false);
    const controller = new TrendsController(
      demand as never,
      insight as never,
      entitlements as never,
    );

    const request = controller.gap(user as never, 'cv-1');
    await expect(request).rejects.toBeInstanceOf(HttpException);
    await expect(request).rejects.toMatchObject({ status: 402 });
    expect(demand.getSkillGap).not.toHaveBeenCalled();
  });

  it('returns personalized market gaps for an active Premium user', async () => {
    const response = { role_code: 'all', skills: [], gap: [] };
    entitlements.hasActivePlan.mockResolvedValue(true);
    demand.getSkillGap.mockResolvedValue(response);
    const controller = new TrendsController(
      demand as never,
      insight as never,
      entitlements as never,
    );

    await expect(controller.gap(user as never, 'cv-1', 'backend', '8')).resolves.toBe(response);
    expect(entitlements.hasActivePlan).toHaveBeenCalledWith('user-1', BillingPlanCode.PREMIUM);
    expect(demand.getSkillGap).toHaveBeenCalledWith('user-1', 'cv-1', 'backend', 8);
  });
});
