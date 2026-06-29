import { Repository } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchScoreEntity } from '../../database/entities/cv-match-score.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { CvMatchesService } from './cv-matches.service';

type RepoMock<T extends object> = Pick<Repository<T>, 'create' | 'findOne' | 'save'> & {
  create: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
};

function repo<T extends object>(): RepoMock<T> {
  return {
    create: jest.fn((input) => input),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve(input)),
  } as unknown as RepoMock<T>;
}

describe('CvMatchesService roadmap quota', () => {
  function setup() {
    const cvs = repo<CvEntity>();
    const jobDescriptions = repo<JobDescriptionEntity>();
    const matches = repo<CvMatchEntity>();
    const scores = repo<CvMatchScoreEntity>();
    const aiResults = repo<AiResultEntity>();
    const extractor = { extract: jest.fn() };
    const matcher = { match: jest.fn() };
    const entitlements = {
      assertCanUse: jest.fn().mockResolvedValue(undefined),
      recordUsage: jest.fn().mockResolvedValue(undefined),
    };
    const gapReport = {
      build: jest.fn().mockResolvedValue({
        target_role: 'frontend_developer',
        gap_items: [],
      }),
    };
    const platformCvs = { getLatestReview: jest.fn().mockResolvedValue(null) };
    const roadmapComposer = { compose: jest.fn() };
    const service = new CvMatchesService(
      cvs as unknown as Repository<CvEntity>,
      jobDescriptions as unknown as Repository<JobDescriptionEntity>,
      matches as unknown as Repository<CvMatchEntity>,
      scores as unknown as Repository<CvMatchScoreEntity>,
      aiResults as unknown as Repository<AiResultEntity>,
      extractor as never,
      matcher as never,
      entitlements as never,
      gapReport as never,
      platformCvs as never,
      undefined,
      undefined,
      undefined,
      roadmapComposer as never,
    );

    matches.findOne.mockResolvedValue({
      id: 'match-1',
      cvId: 'cv-1',
      aiResultId: null,
      jobDescriptionId: null,
      overallScore: '0',
      semanticScore: '0',
      ruleEngineScore: '0',
      strengths: [],
      weaknesses: [],
      suggestions: {},
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    cvs.findOne.mockResolvedValue({ id: 'cv-1', userId: 'user-1' });

    return { service, entitlements, gapReport, platformCvs, roadmapComposer };
  }

  it('checks and records roadmap quota around roadmap generation', async () => {
    const { service, entitlements, gapReport, roadmapComposer } = setup();

    const result = await service.generateRoadmapFromMatch('user-1', 'match-1', {});

    expect(entitlements.assertCanUse).toHaveBeenCalledWith(
      'user-1',
      BillingFeatureKey.ROADMAP_GENERATE,
    );
    expect(entitlements.assertCanUse.mock.invocationCallOrder[0]).toBeLessThan(
      gapReport.build.mock.invocationCallOrder[0],
    );
    expect(entitlements.recordUsage).toHaveBeenCalledWith(
      'user-1',
      BillingFeatureKey.ROADMAP_GENERATE,
      { sourceType: 'cv_match', sourceId: 'match-1' },
    );
    expect(roadmapComposer.compose).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ no_learning_gaps: true }));
  });

  it('does not build a gap report when roadmap quota is exhausted', async () => {
    const { service, entitlements, gapReport, platformCvs } = setup();
    entitlements.assertCanUse.mockRejectedValue(new Error('quota exhausted'));

    await expect(service.generateRoadmapFromMatch('user-1', 'match-1', {})).rejects.toThrow(
      'quota exhausted',
    );

    expect(platformCvs.getLatestReview).not.toHaveBeenCalled();
    expect(gapReport.build).not.toHaveBeenCalled();
    expect(entitlements.recordUsage).not.toHaveBeenCalled();
  });
});
