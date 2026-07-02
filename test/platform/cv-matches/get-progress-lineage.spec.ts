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
    matches.findOne.mockResolvedValueOnce(current);
    jest
      .spyOn(service, 'getGapReport')
      .mockResolvedValueOnce({ gap_items: [] } as never) // current report
      .mockResolvedValueOnce({ gap_items: [] } as never); // prior report

    const out = await service.getProgress('user-1', 'match-current');

    const qb = matches.createQueryBuilder.mock.results[0].value;
    expect(qb.where).toHaveBeenCalledWith('cv.userId = :userId', { userId: 'user-1' });
    expect(qb.andWhere).toHaveBeenCalledWith('jd.contentHash = :hash', { hash: 'h1' });
    expect(service.getGapReport).toHaveBeenNthCalledWith(1, 'user-1', 'match-current');
    expect(service.getGapReport).toHaveBeenNthCalledWith(2, 'user-1', 'match-prior');
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
    matches.findOne.mockResolvedValueOnce(current);
    jest.spyOn(service, 'getGapReport').mockResolvedValue({ gap_items: [] } as never);

    const out = await service.getProgress('user-1', 'match-current');

    expect(out.baseline).toBe(true);
    expect(matches.createQueryBuilder).not.toHaveBeenCalled();
  });
});
