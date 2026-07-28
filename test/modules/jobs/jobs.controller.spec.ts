import { JobsController } from '../../../src/modules/jobs/jobs.controller';

describe('JobsController quota enforcement', () => {
  function build(recommendations: unknown[] = [], total = recommendations.length) {
    const reco = {
      recommendForCv: jest.fn().mockResolvedValue({
        cv_id: 'cv-1',
        pool_size: 1,
        total,
        limit: 5,
        offset: 0,
        recommendations,
      }),
    };
    const reservation = {
      reused: false,
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

    expect(entitlements.reserveUsage).toHaveBeenCalledWith(
      'user-1',
      'job_recommendation',
      {
        sourceType: 'cv',
        sourceId: 'cv-1',
      },
      { dedupeBySource: true },
    );
    expect(reco.recommendForCv).toHaveBeenCalledWith('user-1', 'cv-1', {
      limit: 5,
      offset: 0,
      roleCode: undefined,
      cityCodes: undefined,
      workModes: undefined,
      employmentTypes: undefined,
      experienceLevels: undefined,
      fitVerdicts: undefined,
      sort: 'RECOMMENDED',
      salaryOnly: false,
    });
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('refunds the charge when the pool is genuinely empty (total 0)', async () => {
    const { controller, reservation } = build([], 0);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('keeps the charge for an over-paginated empty page (total > 0)', async () => {
    // offset past the end returns [] but the scoring+embedding pipeline ran —
    // refunding here would let a client farm unlimited free scored calls.
    const { controller, reservation } = build([], 7);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('does not refund a reused source charge when a filtered page is empty', async () => {
    const { controller, reservation } = build([], 0);
    reservation.reused = true;

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(reservation.refund).not.toHaveBeenCalled();
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
