import { Repository } from 'typeorm';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchScoreEntity } from '../../database/entities/cv-match-score.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { getSkillBridgeLessonContent } from '../../modules/roadmap/skillbridge-lesson-content';
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

function setup(
  opts: {
    githubEvidence?: unknown;
    interviewSessions?: { findOne: jest.Mock };
    learningProgress?: { find: jest.Mock };
  } = {},
) {
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
    undefined, // impactCalibrations (ME2)
    undefined, // aiRequests (ME2)
    opts.interviewSessions as never,
    opts.learningProgress as never,
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
  const learnableGap = {
    requirement_id: 'jd:hard_skill:react',
    type: 'hard_skill',
    canonical_name: 'react',
    display_name: 'React',
    cv_status: 'missing',
    importance: 'REQUIRED',
    severity: 0.9,
    fixability: 'learn',
    recommended_next_action: 'Learn React fundamentals.',
  };

  it('does not reserve roadmap quota when the match has no learning gaps', async () => {
    const { service, entitlements, reservation, roadmapComposer } = setup();

    const result = await service.generateRoadmapFromMatch('user-1', 'match-1', {});

    expect(entitlements.reserveUsage).not.toHaveBeenCalled();
    expect(reservation.refund).not.toHaveBeenCalled();
    expect(roadmapComposer.compose).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ no_learning_gaps: true }));
  });

  it('checks quota after deriving that a learnable gap exists', async () => {
    const { service, entitlements, reservation, gapReport } = setup();
    gapReport.build.mockResolvedValue({
      target_role: 'frontend_developer',
      gap_items: [learnableGap],
    });
    entitlements.reserveUsage.mockRejectedValue(new Error('quota exhausted'));

    await expect(service.generateRoadmapFromMatch('user-1', 'match-1', {})).rejects.toThrow(
      'quota exhausted',
    );

    expect(gapReport.build).toHaveBeenCalledTimes(1);
    expect(gapReport.build.mock.invocationCallOrder[0]).toBeLessThan(
      entitlements.reserveUsage.mock.invocationCallOrder[0],
    );
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('refunds the reserved charge when composition fails after the reserve', async () => {
    const { service, reservation, gapReport, roadmapComposer } = setup();
    gapReport.build.mockResolvedValue({
      target_role: 'frontend_developer',
      gap_items: [learnableGap],
    });
    roadmapComposer.compose.mockRejectedValue(new Error('composer unavailable'));

    await expect(service.generateRoadmapFromMatch('user-1', 'match-1', {})).rejects.toThrow(
      'composer unavailable',
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

describe('CvMatchesService interview signals (V1, Wave VALUE_CHAIN)', () => {
  it('threads the latest completed interview outcome as an interviewSignals Map into the gap-report build', async () => {
    const interviewSessions = { findOne: jest.fn() };
    interviewSessions.findOne.mockResolvedValue({
      id: 'sess-abcd-1234',
      gapItems: [
        // knowledge/evidence gaps with a canonical → signal; max severity wins per canonical.
        {
          weakness_type: 'knowledge_gap',
          skill_canonical: 'sql',
          display_name: 'SQL',
          severity: 0.5,
        },
        {
          weakness_type: 'evidence_gap',
          skill_canonical: 'sql',
          display_name: 'SQL',
          severity: 0.8,
        },
        // not skill-anchored / no canonical → excluded from the signal map.
        {
          weakness_type: 'communication_gap',
          skill_canonical: null,
          display_name: 'Trình bày',
          severity: 0.9,
        },
        {
          weakness_type: 'knowledge_gap',
          skill_canonical: null,
          display_name: 'General',
          severity: 0.9,
        },
      ],
    });
    const { service, gapReport } = setup({ interviewSessions });

    await service.getGapReport('user-1', 'match-1', 'vi');

    expect(interviewSessions.findOne).toHaveBeenCalledTimes(1);
    const call = gapReport.build.mock.calls[0][0];
    expect(call.interviewSignals).toBeInstanceOf(Map);
    expect(call.interviewSignals.get('sql')).toEqual({
      risk: 0.8,
      ref: 'sess-abc',
      display: 'SQL',
    });
    expect(call.interviewSignals.size).toBe(1);
  });

  it('no completed interview session for the match → interviewSignals undefined (byte-identical)', async () => {
    const interviewSessions = { findOne: jest.fn().mockResolvedValue(null) };
    const { service, gapReport } = setup({ interviewSessions });

    await service.getGapReport('user-1', 'match-1', 'vi');

    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({ interviewSignals: undefined }),
    );
  });

  it('never-throws: interview lookup failure degrades to no signals', async () => {
    const interviewSessions = { findOne: jest.fn().mockRejectedValue(new Error('db down')) };
    const { service, gapReport } = setup({ interviewSessions });

    const result = await service.getGapReport('user-1', 'match-1', 'vi');

    expect(result).toEqual(expect.objectContaining({ target_role: 'frontend_developer' }));
    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({ interviewSignals: undefined }),
    );
  });

  it('getProgress does NOT fetch interview signals (ME2 calibration must compare prior-vs-current severity apples-to-apples)', async () => {
    const interviewSessions = { findOne: jest.fn() };
    const { service, gapReport } = setup({ interviewSessions });

    await service.getProgress('user-1', 'match-1');

    expect(interviewSessions.findOne).not.toHaveBeenCalled();
    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({ interviewSignals: undefined }),
    );
  });
});

describe('CvMatchesService mastered learning → learning_completed (V2, Wave VALUE_CHAIN)', () => {
  // Real lesson content (Khoa's, read-only) drives the fixtures: the aggregation must judge mastery
  // with the REAL per-objective predicate over the REAL react quiz bank, not a hand-rolled copy.
  const lesson = getSkillBridgeLessonContent('react');
  if (!lesson) throw new Error('react lesson content missing — fixture precondition');

  const attempt = (q: { id: string; correct_option_index: number }, isCorrect: boolean) => [
    q.id,
    {
      selected_option_index: isCorrect ? q.correct_option_index : q.correct_option_index + 1,
      is_correct: isCorrect,
      attempts: 1,
      answered_at: '2026-07-01T00:00:00.000Z',
    },
  ];

  /** Every quiz-bank question answered correctly → every objective mastered. */
  const allCorrectAttempts = Object.fromEntries(lesson.quiz_bank.map((q) => attempt(q, true)));

  const openReactGap = {
    requirement_id: 'jd:hard_skill:react',
    canonical_name: 'react',
    display_name: 'React',
    cv_status: 'missing',
    severity: 0.5,
    evidence_risk: 'none',
  };

  function gapReportWithOpenReact(gapReport: { build: jest.Mock }) {
    gapReport.build.mockResolvedValue({
      target_role: 'frontend_developer',
      gap_items: [openReactGap],
    });
  }

  it('fully-mastered lesson ∩ open gap → progress carries learning_completed (pending verification)', async () => {
    const learningProgress = {
      find: jest
        .fn()
        .mockResolvedValue([{ sessionId: 'roadmap-react', quizAttempts: allCorrectAttempts }]),
    };
    const { service, gapReport } = setup({ learningProgress });
    gapReportWithOpenReact(gapReport);

    const result = await service.getProgress('user-1', 'match-1');

    expect(learningProgress.find).toHaveBeenCalledTimes(1);
    expect(learningProgress.find).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(result.learning_completed).toEqual(['react']);
  });

  it('partially-mastered lesson (only one objective answered) → NOT counted, field absent', async () => {
    // Precondition: the aggregate is only meaningful when the lesson has >1 objective.
    expect(lesson.learning_objectives.length).toBeGreaterThan(1);
    const firstObjectiveId = lesson.learning_objectives[0].id;
    const partialAttempts = Object.fromEntries(
      lesson.quiz_bank
        .filter((q) => q.objective_id === firstObjectiveId)
        .map((q) => attempt(q, true)),
    );
    const learningProgress = {
      find: jest
        .fn()
        .mockResolvedValue([{ sessionId: 'roadmap-react', quizAttempts: partialAttempts }]),
    };
    const { service, gapReport } = setup({ learningProgress });
    gapReportWithOpenReact(gapReport);

    const result = await service.getProgress('user-1', 'match-1');

    expect(result).not.toHaveProperty('learning_completed');
  });

  it('unknown session ids (not roadmap-<skill>) are skipped, not crashed on', async () => {
    const learningProgress = {
      find: jest
        .fn()
        .mockResolvedValue([{ sessionId: 'custom-session-42', quizAttempts: allCorrectAttempts }]),
    };
    const { service, gapReport } = setup({ learningProgress });
    gapReportWithOpenReact(gapReport);

    const result = await service.getProgress('user-1', 'match-1');

    expect(result).not.toHaveProperty('learning_completed');
  });

  it('no learning rows → progress output byte-identical to a service without the dependency', async () => {
    const learningProgress = { find: jest.fn().mockResolvedValue([]) };
    const withDep = setup({ learningProgress });
    const withoutDep = setup();
    gapReportWithOpenReact(withDep.gapReport);
    gapReportWithOpenReact(withoutDep.gapReport);

    const a = await withDep.service.getProgress('user-1', 'match-1');
    const b = await withoutDep.service.getProgress('user-1', 'match-1');

    expect(a).not.toHaveProperty('learning_completed');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never-throws: learning-progress lookup failure degrades to no learning_completed', async () => {
    const learningProgress = { find: jest.fn().mockRejectedValue(new Error('db down')) };
    const { service, gapReport } = setup({ learningProgress });
    gapReportWithOpenReact(gapReport);

    const result = await service.getProgress('user-1', 'match-1');

    expect(result).toEqual(expect.objectContaining({ baseline: true }));
    expect(result).not.toHaveProperty('learning_completed');
  });

  it('absent dependency (positional construction) → getProgress still works, field absent', async () => {
    const { service, gapReport } = setup();
    gapReportWithOpenReact(gapReport);

    const result = await service.getProgress('user-1', 'match-1');

    expect(result).toEqual(expect.objectContaining({ baseline: true }));
    expect(result).not.toHaveProperty('learning_completed');
  });

  it('getGapReport does NOT fetch learning progress (progress-only presentation pre-pass)', async () => {
    const learningProgress = { find: jest.fn() };
    const { service } = setup({ learningProgress });

    await service.getGapReport('user-1', 'match-1', 'vi');

    expect(learningProgress.find).not.toHaveBeenCalled();
  });
});
