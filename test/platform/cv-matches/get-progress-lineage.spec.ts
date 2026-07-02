import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';

function qbMock(result: unknown) {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
  };
  return qb;
}

describe('CvMatchesService.getProgress lineage (user + JD content hash)', () => {
  function build(priorMatch: unknown) {
    const cvsRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'cv-2', userId: 'user-1', deletedAt: null }),
    };
    const jobDescriptionsRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'jd-2', contentHash: 'h1' }),
    };
    const matches = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(qbMock(priorMatch)),
    };

    const service = new CvMatchesService(
      cvsRepo as never,
      jobDescriptionsRepo as never,
      matches as never,
      {} as never, // scores
      {} as never, // aiResults
      {} as never, // extractor
      {} as never, // matcher
      {} as never, // entitlements
    );

    return { service, cvsRepo, jobDescriptionsRepo, matches };
  }

  /**
   * `loadOwnedMatchParsedResponse`/`buildGapReportFromParsed`/`resolveParsedResponse` all hit
   * repos (aiResults, gapReport, platformCvs) not wired in this lineage-only fixture — spy them
   * directly rather than standing up the full dependency graph, same spirit as spying on
   * `getGapReport` before the getProgress refactor.
   */
  function stubReportBuilding(
    service: CvMatchesService,
    opts: {
      current: unknown;
      currParsed: unknown;
      currGapItems: unknown[];
      prevParsed?: unknown;
      prevGapItems?: unknown[];
    },
  ) {
    jest
      .spyOn(service as never, 'loadOwnedMatchParsedResponse')
      .mockResolvedValue({ match: opts.current, parsed: opts.currParsed } as never);
    const buildGapReportFromParsed = jest.spyOn(service as never, 'buildGapReportFromParsed');
    buildGapReportFromParsed.mockResolvedValueOnce({ gap_items: opts.currGapItems } as never);
    if (opts.prevGapItems) {
      buildGapReportFromParsed.mockResolvedValueOnce({ gap_items: opts.prevGapItems } as never);
    }
    if (opts.prevParsed !== undefined) {
      jest
        .spyOn(service as never, 'resolveParsedResponse')
        .mockResolvedValue(opts.prevParsed as never);
    }
    return buildGapReportFromParsed;
  }

  it('finds the prior by user + JD content_hash across different cvIds', async () => {
    const prior = {
      id: 'match-prior',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      overallScore: '60.00',
    };
    const current = {
      id: 'match-current',
      cvId: 'cv-2',
      jobDescriptionId: 'jd-2',
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      overallScore: '80.00',
    };
    const { service, matches } = build(prior);
    const currParsed = { required_coverage: 0.5 };
    const prevParsed = { required_coverage: 0.4 };
    const buildGapReportFromParsed = stubReportBuilding(service, {
      current,
      currParsed,
      currGapItems: [],
      prevParsed,
      prevGapItems: [],
    });

    const out = await service.getProgress('user-1', 'match-current');

    const qb = matches.createQueryBuilder.mock.results[0].value;
    expect(qb.where).toHaveBeenCalledWith('cv.userId = :userId', { userId: 'user-1' });
    expect(qb.andWhere).toHaveBeenCalledWith('jd.contentHash = :hash', { hash: 'h1' });
    expect(buildGapReportFromParsed).toHaveBeenNthCalledWith(1, 'user-1', current, currParsed);
    expect(buildGapReportFromParsed).toHaveBeenNthCalledWith(2, 'user-1', prior, prevParsed);
    expect(out.baseline).toBe(false);
  });

  it('returns baseline when the current JD has no content_hash (legacy row)', async () => {
    const current = {
      id: 'match-current',
      cvId: 'cv-2',
      jobDescriptionId: 'jd-legacy',
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      overallScore: '80.00',
    };
    const { service, matches, jobDescriptionsRepo } = build(null);
    jobDescriptionsRepo.findOne.mockResolvedValue({ id: 'jd-legacy', contentHash: null });
    stubReportBuilding(service, {
      current,
      currParsed: { required_coverage: 0.5 },
      currGapItems: [],
    });

    const out = await service.getProgress('user-1', 'match-current');

    expect(out.baseline).toBe(true);
    expect(matches.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('flags template_changed and nulls prev_score when the prior parsed response predates jd_dimensions (v1 → v2)', async () => {
    const prior = {
      id: 'match-prior',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      overallScore: '60.00',
    };
    const current = {
      id: 'match-current',
      cvId: 'cv-2',
      jobDescriptionId: 'jd-2',
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      overallScore: '80.00',
    };
    const { service } = build(prior);
    // curr is v2 (carries jd_dimensions); prior predates the v2 template (no jd_dimensions key at all).
    const currParsed = { required_coverage: 0.6, jd_dimensions: [] };
    const prevParsed = { required_coverage: 0.4 };
    stubReportBuilding(service, {
      current,
      currParsed,
      currGapItems: [],
      prevParsed,
      prevGapItems: [],
    });

    const out = await service.getProgress('user-1', 'match-current');

    expect(out.template_changed).toBe(true);
    expect(out.prev_score).toBeNull();
    expect(out.required_coverage_delta).toBeNull();
  });

  it('computes required_coverage_delta from required_coverage on both parsed responses when both are v2', async () => {
    const prior = {
      id: 'match-prior',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      overallScore: '60.00',
    };
    const current = {
      id: 'match-current',
      cvId: 'cv-2',
      jobDescriptionId: 'jd-2',
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      overallScore: '80.00',
    };
    const { service } = build(prior);
    const currParsed = { required_coverage: 0.75, jd_dimensions: [] };
    const prevParsed = { required_coverage: 0.5, jd_dimensions: [] };
    stubReportBuilding(service, {
      current,
      currParsed,
      currGapItems: [],
      prevParsed,
      prevGapItems: [],
    });

    const out = await service.getProgress('user-1', 'match-current');

    expect(out.template_changed).toBe(false);
    expect(out.required_coverage_delta).toBeCloseTo(0.25);
    expect(out.prev_score).toBe(60);
  });
});
