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

function setup(opts: { githubEvidence?: unknown } = {}) {
  const cvs = repo<CvEntity>();
  const jobDescriptions = repo<JobDescriptionEntity>();
  const matches = repo<CvMatchEntity>();
  const scores = repo<CvMatchScoreEntity>();
  const aiResults = repo<AiResultEntity>();
  const extractor = { extract: jest.fn() };
  const matcher = { match: jest.fn() };
  const reservation = {
    eventId: 'usage-1',
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const entitlements = {
    reserveUsage: jest.fn().mockResolvedValue(reservation),
  };
  const gapReport = {
    build: jest.fn().mockResolvedValue({
      target_role: 'frontend_developer',
      gap_items: [],
    }),
  };
  const platformCvs = { getLatestReview: jest.fn().mockResolvedValue(null) };
  const roadmapComposer = { compose: jest.fn() };
  const interviewPlan = { phrasePlan: jest.fn() };
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
    interviewPlan as never,
    roadmapComposer as never,
    undefined,
    opts.githubEvidence as never,
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

  return {
    service,
    entitlements,
    reservation,
    gapReport,
    platformCvs,
    roadmapComposer,
    interviewPlan,
  };
}

describe('CvMatchesService roadmap quota', () => {
  it('reserves roadmap quota atomically before roadmap generation and keeps the charge', async () => {
    const { service, entitlements, reservation, gapReport, roadmapComposer } = setup();

    const result = await service.generateRoadmapFromMatch('user-1', 'match-1', {});

    expect(entitlements.reserveUsage).toHaveBeenCalledWith(
      'user-1',
      BillingFeatureKey.ROADMAP_GENERATE,
      { sourceType: 'cv_match', sourceId: 'match-1' },
    );
    expect(entitlements.reserveUsage.mock.invocationCallOrder[0]).toBeLessThan(
      gapReport.build.mock.invocationCallOrder[0],
    );
    expect(reservation.refund).not.toHaveBeenCalled();
    expect(roadmapComposer.compose).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ no_learning_gaps: true }));
  });

  it('does not build a gap report when roadmap quota is exhausted', async () => {
    const { service, entitlements, reservation, gapReport, platformCvs } = setup();
    entitlements.reserveUsage.mockRejectedValue(new Error('quota exhausted'));

    await expect(service.generateRoadmapFromMatch('user-1', 'match-1', {})).rejects.toThrow(
      'quota exhausted',
    );

    expect(platformCvs.getLatestReview).not.toHaveBeenCalled();
    expect(gapReport.build).not.toHaveBeenCalled();
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('refunds the reserved charge when roadmap generation fails after the reserve', async () => {
    const { service, reservation, gapReport } = setup();
    gapReport.build.mockRejectedValue(new Error('gap report unavailable'));

    await expect(service.generateRoadmapFromMatch('user-1', 'match-1', {})).rejects.toThrow(
      'gap report unavailable',
    );

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });
});

describe('CvMatchesService github corroboration (I3, Wave IMPACT)', () => {
  function githubEvidenceMock(corroborated: Array<{ skill_canonical: string; repoName: string }>) {
    return {
      build: jest.fn().mockResolvedValue({
        available: true,
        username: 'octocat',
        analyzed_repo_count: corroborated.length,
        cv_skill_join: true,
        corroborated: corroborated.map((c) => ({
          skill_canonical: c.skill_canonical,
          display_name: c.skill_canonical,
          repos: [
            {
              name: c.repoName,
              url: `https://github.com/octocat/${c.repoName}`,
              pushed_year: 2025,
            },
          ],
          repo_count: 1,
          most_recent_year: 2025,
          why: '',
        })),
        github_only: [],
      }),
    };
  }

  it('does not fetch github evidence when the request has no github params', async () => {
    const githubEvidence = githubEvidenceMock([]);
    const { service, gapReport } = setup({ githubEvidence });

    await service.getGapReport('user-1', 'match-1', 'vi');

    expect(githubEvidence.build).not.toHaveBeenCalled();
    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({ corroborated: undefined }),
    );
  });

  it('fetches github evidence and threads a corroborated Map into the gap-report build when opted in', async () => {
    const githubEvidence = githubEvidenceMock([
      { skill_canonical: 'react', repoName: 'my-react-app' },
    ]);
    const { service, gapReport, platformCvs } = setup({ githubEvidence });

    await service.getGapReport('user-1', 'match-1', 'vi', { username: 'octocat', consent: true });

    // platformCvs mock always resolves null (no review fixture needed for this wiring test).
    expect(githubEvidence.build).toHaveBeenCalledWith({
      username: 'octocat',
      consent: true,
      review: null,
      lang: 'vi',
    });
    expect(platformCvs.getLatestReview).toHaveBeenCalledWith('user-1', 'cv-1');
    const call = gapReport.build.mock.calls[0][0];
    expect(call.corroborated).toBeInstanceOf(Map);
    expect(call.corroborated.get('react')).toEqual({ ref: 'my-react-app' });
  });

  it('never-throws: degrades to no corroboration when the github fetch fails', async () => {
    const githubEvidence = { build: jest.fn().mockRejectedValue(new Error('rate limited')) };
    const { service, gapReport } = setup({ githubEvidence });

    const result = await service.getGapReport('user-1', 'match-1', 'vi', {
      username: 'octocat',
      consent: true,
    });

    expect(result).toEqual(expect.objectContaining({ target_role: 'frontend_developer' }));
    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({ corroborated: undefined }),
    );
  });

  it('sub-report callers (next-steps) never pass github params, so they never fetch github evidence', async () => {
    const githubEvidence = githubEvidenceMock([
      { skill_canonical: 'react', repoName: 'my-react-app' },
    ]);
    const { service, gapReport } = setup({ githubEvidence });

    await service.getNextSteps('user-1', 'match-1', 'vi');

    expect(githubEvidence.build).not.toHaveBeenCalled();
    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({ corroborated: undefined }),
    );
  });

  it('sub-report callers (interview-plan-from-match) never fetch github evidence', async () => {
    const githubEvidence = githubEvidenceMock([
      { skill_canonical: 'react', repoName: 'my-react-app' },
    ]);
    const { service, gapReport, interviewPlan } = setup({ githubEvidence });
    interviewPlan.phrasePlan.mockResolvedValue({
      ai_request_id: '',
      target_role: 'frontend_developer',
      language: 'vi',
      items: [],
      llm_enhanced: false,
      token_usage: 0,
    });

    await service.generateInterviewPlanFromMatch('user-1', 'match-1', {});

    expect(githubEvidence.build).not.toHaveBeenCalled();
    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({ corroborated: undefined }),
    );
  });
});
