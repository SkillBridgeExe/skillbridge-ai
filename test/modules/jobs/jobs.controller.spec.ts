import { JobsController } from '../../../src/modules/jobs/jobs.controller';

describe('JobsController quota enforcement', () => {
  function build(recommendations: unknown[] = []) {
    const reco = {
      recommendForCv: jest.fn().mockResolvedValue({
        cv_id: 'cv-1',
        pool_size: 1,
        total: recommendations.length,
        limit: 5,
        offset: 0,
        recommendations,
      }),
    };
    const reservation = {
      refund: jest.fn().mockResolvedValue(undefined),
      confirm: jest.fn().mockResolvedValue(undefined),
    };
    const entitlements = {
      reserveUsage: jest.fn().mockResolvedValue(reservation),
    };
    const controller = new JobsController(reco as never, entitlements as never);
    return { controller, reco, entitlements, reservation };
  }

  it('reserves quota and keeps the charge when recommendations are delivered', async () => {
    const { controller, reco, entitlements, reservation } = build([{ job_id: 'job-1' }]);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(entitlements.reserveUsage).toHaveBeenCalledWith('user-1', 'job_recommendation', {
      sourceType: 'cv',
      sourceId: 'cv-1',
    });
    expect(reco.recommendForCv).toHaveBeenCalledWith('user-1', 'cv-1', {
      limit: undefined,
      offset: undefined,
      roleCode: undefined,
    });
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('refunds the charge when the pool returns zero recommendations', async () => {
    const { controller, reservation } = build([]);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('refunds the charge when the recommendation service throws', async () => {
    const { controller, reco, reservation } = build();
    reco.recommendForCv.mockRejectedValue(new Error('pool unavailable'));

    await expect(controller.recommend({ userId: 'user-1' } as never, 'cv-1')).rejects.toThrow(
      'pool unavailable',
    );

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('does not call the recommendation service when the reserve is denied', async () => {
    const { controller, reco, entitlements } = build();
    entitlements.reserveUsage.mockRejectedValue(new Error('quota denied'));

    await expect(controller.recommend({ userId: 'user-1' } as never, 'cv-1')).rejects.toThrow(
      'quota denied',
    );

    expect(reco.recommendForCv).not.toHaveBeenCalled();
  });
});
