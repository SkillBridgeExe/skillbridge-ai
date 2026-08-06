import { JobsController } from '../../../src/modules/jobs/jobs.controller';

describe('JobsController quota enforcement', () => {
  function build(
    recommendations: unknown[] = [],
    total = recommendations.length,
    cacheHit = false,
    snapshotSize = total,
  ) {
    const reco = {
      recommendForCv: jest.fn(
        async (
          _userId: string,
          _cvId: string,
          _options: unknown,
          hooks: { beforeGenerate?: () => Promise<void> },
        ) => {
          if (!cacheHit) await hooks.beforeGenerate?.();
          return {
            cv_id: 'cv-1',
            pool_size: 1,
            total,
            limit: 5,
            offset: 0,
            generation: { cache_hit: cacheHit, snapshot_size: snapshotSize },
            recommendations,
          };
        },
      ),
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
    expect(reco.recommendForCv).toHaveBeenCalledWith(
      'user-1',
      'cv-1',
      {
        query: undefined,
        cityCodes: [],
        cityNames: [],
        districtCodes: [],
        employmentTypes: [],
        experienceLevels: [],
        fit: [],
        limit: undefined,
        offset: undefined,
        postedFrom: undefined,
        postedTo: undefined,
        salaryCurrency: undefined,
        salaryMax: undefined,
        salaryMin: undefined,
        roleCode: undefined,
        snapshotToken: undefined,
        salaryOnly: false,
        sourceNames: [],
        sort: 'RECOMMENDED',
        workModes: [],
      },
      expect.objectContaining({ beforeGenerate: expect.any(Function) }),
    );
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('refunds the charge when the generated snapshot is genuinely empty', async () => {
    const { controller, reservation } = build([], 0, false, 0);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('keeps the charge when filters hide every row from a non-empty generated snapshot', async () => {
    const { controller, reservation } = build([], 0, false, 7);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('keeps the charge for an over-paginated empty page (total > 0)', async () => {
    // offset past the end returns [] but the scoring+embedding pipeline ran —
    // refunding here would let a client farm unlimited free scored calls.
    const { controller, reservation } = build([], 7);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('does not reserve quota when filters/pages reuse a cached snapshot', async () => {
    const { controller, entitlements } = build([{ job_id: 'job-1' }], 1, true);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1', {
      offset: '5',
      sort: 'NEWEST',
    });

    expect(entitlements.reserveUsage).not.toHaveBeenCalled();
  });

  it('refunds the charge when the recommendation service throws', async () => {
    const { controller, reco, reservation } = build();
    reco.recommendForCv.mockImplementation(
      async (
        _userId: string,
        _cvId: string,
        _options: unknown,
        hooks: { beforeGenerate?: () => Promise<void> },
      ) => {
        await hooks.beforeGenerate?.();
        throw new Error('pool unavailable');
      },
    );

    await expect(controller.recommend({ userId: 'user-1' } as never, 'cv-1')).rejects.toThrow(
      'pool unavailable',
    );

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('does not run the expensive generator when the cache-miss reserve is denied', async () => {
    const { controller, reco, entitlements } = build();
    entitlements.reserveUsage.mockRejectedValue(new Error('quota denied'));

    await expect(controller.recommend({ userId: 'user-1' } as never, 'cv-1')).rejects.toThrow(
      'quota denied',
    );

    expect(reco.recommendForCv).toHaveBeenCalledTimes(1);
  });

  it('normalizes explorer query fields before invoking the service', async () => {
    const { controller, reco } = build([{ job_id: 'job-1' }]);

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1', {
      limit: '10',
      offset: '20',
      role: 'all',
      q: 'node',
      cityCodes: 'hcm,HAN,HCM',
      cityNames: 'Da Nang, Hồ Chí Minh, Da Nang',
      districtCodes: 'quan_1,thu_duc',
      sourceNames: 'itviec,business',
      workModes: 'REMOTE,HYBRID',
      employmentTypes: 'FULL_TIME,INTERNSHIP',
      experienceLevels: 'FRESHER,JUNIOR',
      fit: 'safe_apply,stretch',
      postedFrom: '2026-08-01',
      postedTo: '2026-08-05',
      salaryMin: '20000000',
      salaryMax: '40000000',
      salaryCurrency: 'vnd',
      salaryOnly: 'true',
      sort: 'NEWEST',
      snapshotToken: '11111111-1111-4111-8111-111111111111',
    });

    expect(reco.recommendForCv).toHaveBeenCalledWith(
      'user-1',
      'cv-1',
      {
        limit: 10,
        offset: 20,
        roleCode: 'all',
        snapshotToken: '11111111-1111-4111-8111-111111111111',
        query: 'node',
        cityCodes: ['HCM', 'HAN'],
        cityNames: ['Da Nang', 'Hồ Chí Minh'],
        districtCodes: ['QUAN_1', 'THU_DUC'],
        sourceNames: ['itviec', 'business'],
        workModes: ['REMOTE', 'HYBRID'],
        employmentTypes: ['FULL_TIME', 'INTERNSHIP'],
        experienceLevels: ['FRESHER', 'JUNIOR'],
        fit: ['safe_apply', 'stretch'],
        postedFrom: '2026-08-01T00:00:00.000Z',
        postedTo: '2026-08-05T23:59:59.999Z',
        salaryMin: 20_000_000,
        salaryMax: 40_000_000,
        salaryCurrency: 'VND',
        salaryOnly: true,
        sort: 'NEWEST',
      },
      expect.any(Object),
    );
  });

  it('refunds a reserved generation when another lease wins and the response becomes a cache hit', async () => {
    const { controller, reco, reservation } = build([{ job_id: 'job-1' }]);
    reco.recommendForCv.mockImplementation(
      async (
        _userId: string,
        _cvId: string,
        _options: unknown,
        hooks: { beforeGenerate?: () => Promise<void> },
      ) => {
        await hooks.beforeGenerate?.();
        return {
          cv_id: 'cv-1',
          pool_size: 1,
          total: 1,
          limit: 5,
          offset: 0,
          generation: { cache_hit: true, snapshot_size: 1 },
          recommendations: [{ job_id: 'job-1' }],
        };
      },
    );

    await controller.recommend({ userId: 'user-1' } as never, 'cv-1');

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported filter values before running the recommendation pipeline', async () => {
    const { controller, reco, entitlements, reservation } = build();

    await expect(
      controller.recommend({ userId: 'user-1' } as never, 'cv-1', {
        workModes: 'TELEPORT',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(reco.recommendForCv).not.toHaveBeenCalled();
    expect(entitlements.reserveUsage).not.toHaveBeenCalled();
    expect(reservation.refund).not.toHaveBeenCalled();
  });
});
