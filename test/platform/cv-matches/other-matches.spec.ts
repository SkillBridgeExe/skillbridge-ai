import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';

type QueryBuilderMock = {
  innerJoin: jest.MockedFunction<
    (entity: unknown, alias: string, condition: string) => QueryBuilderMock
  >;
  leftJoin: jest.MockedFunction<
    (entity: unknown, alias: string, condition: string) => QueryBuilderMock
  >;
  where: jest.MockedFunction<
    (condition: string, params: Record<string, unknown>) => QueryBuilderMock
  >;
  andWhere: jest.MockedFunction<
    (condition: string, params: Record<string, unknown>) => QueryBuilderMock
  >;
  orderBy: jest.MockedFunction<(sort: string, order: 'ASC' | 'DESC') => QueryBuilderMock>;
  take: jest.MockedFunction<(limit: number) => QueryBuilderMock>;
  select: jest.MockedFunction<(columns: string[]) => QueryBuilderMock>;
  getRawMany: jest.MockedFunction<() => Promise<unknown[]>>;
};

function qbMock(rows: unknown[]) {
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  } as QueryBuilderMock;
  return qb;
}

describe('CvMatchesService.listRecentMatchSummariesForUser', () => {
  function build(rows: unknown[]) {
    const queryBuilder = qbMock(rows);
    const matchesRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const service = new CvMatchesService(
      {} as never,
      {} as never,
      matchesRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    return { service, matchesRepo, queryBuilder };
  }

  it('returns recent owned match summaries with top persisted gaps', async () => {
    const createdAt = new Date('2026-07-02T08:00:00.000Z');
    const { service, matchesRepo, queryBuilder } = build([
      {
        jdTitle: 'Frontend Developer',
        overallScore: '72.50',
        suggestions: {
          missing_skills: [
            { display_name: 'React' },
            { display_name: 'TypeScript' },
            { display_name: 'Testing' },
          ],
          partial_skills: [{ display_name: 'English' }],
        },
        createdAt,
      },
      {
        jdTitle: null,
        overallScore: null,
        suggestions: {
          missing_skills: [],
          partial_skills: [{ display_name: 'Docker' }],
        },
        createdAt: new Date('2026-07-01T08:00:00.000Z'),
      },
    ]);

    const out = await service.listRecentMatchSummariesForUser('user-1', 'match-current', 2);

    expect(matchesRepo.createQueryBuilder).toHaveBeenCalledWith('m');
    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      expect.any(Function),
      'cv',
      'cv.id = m.cvId',
    );
    expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
      expect.any(Function),
      'jd',
      'jd.id = m.jobDescriptionId',
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('cv.userId = :userId', {
      userId: 'user-1',
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('m.id != :excludeMatchId', {
      excludeMatchId: 'match-current',
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('cv.deletedAt IS NULL');
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('m.createdAt', 'DESC');
    expect(queryBuilder.take).toHaveBeenCalledWith(2);
    expect(queryBuilder.select).toHaveBeenCalledWith([
      'jd.title AS "jdTitle"',
      'm.overallScore AS "overallScore"',
      'm.suggestions AS "suggestions"',
      'm.createdAt AS "createdAt"',
    ]);
    expect(out).toEqual([
      {
        jd_title: 'Frontend Developer',
        overall_score: 72.5,
        top_gaps: ['React', 'TypeScript'],
        created_at: '2026-07-02T08:00:00.000Z',
      },
      {
        jd_title: null,
        overall_score: null,
        top_gaps: ['Docker'],
        created_at: '2026-07-01T08:00:00.000Z',
      },
    ]);
  });

  it('degrades malformed persisted suggestions to an empty top_gaps list', async () => {
    const { service } = build([
      {
        jdTitle: 'Backend Developer',
        overallScore: 81,
        suggestions: {
          missing_skills: [{ canonical_name: 'node_js' }],
          partial_skills: 'not-an-array',
        },
        createdAt: new Date('2026-07-02T09:00:00.000Z'),
      },
    ]);

    await expect(
      service.listRecentMatchSummariesForUser('user-1', 'match-current'),
    ).resolves.toEqual([
      {
        jd_title: 'Backend Developer',
        overall_score: 81,
        top_gaps: [],
        created_at: '2026-07-02T09:00:00.000Z',
      },
    ]);
  });
});
