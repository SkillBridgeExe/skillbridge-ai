import { JobsController } from '../../../src/modules/jobs/jobs.controller';

describe('JobsController quota enforcement', () => {
  function build() {
    const reco = {
      recommendForCv: jest.fn().mockResolvedValue({
        cv_id: 'cv-1',
        pool_size: 1,
        total: 1,
        limit: 5,
        offset: 0,
        recommendations: [],
      }),
    };
    const entitlements = {
      assertCanUse: jest.fn().mockResolvedValue(undefined),
      recordUsage: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new JobsController(reco as never, entitlements as never);
    return { controller, reco, entitlements };
  }

  it('checks and records job recommendation quota around successful recommendations', async () => {
    const { controller, reco, entitlements } = build();

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(entitlements.assertCanUse).toHaveBeenCalledWith('user-1', 'job_recommendation');
    expect(reco.recommendForCv).toHaveBeenCalledWith('user-1', 'cv-1', {
      limit: undefined,
      offset: undefined,
      roleCode: undefined,
    });
    expect(entitlements.recordUsage).toHaveBeenCalledWith('user-1', 'job_recommendation', {
      sourceType: 'cv',
      sourceId: 'cv-1',
    });
  });

  it('does not call recommendation service or record usage when quota is denied', async () => {
    const { controller, reco, entitlements } = build();
    entitlements.assertCanUse.mockRejectedValue(new Error('quota denied'));

    await expect(controller.recommend({ userId: 'user-1' } as never, 'cv-1')).rejects.toThrow(
      'quota denied',
    );

    expect(reco.recommendForCv).not.toHaveBeenCalled();
    expect(entitlements.recordUsage).not.toHaveBeenCalled();
  });
});
