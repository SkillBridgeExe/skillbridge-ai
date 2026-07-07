import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LessThan } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { InterviewQuestionBankItemEntity } from '../../database/entities/interview-question-bank-item.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { InterviewsService } from './interviews.service';

function repo<T extends { id?: string }>() {
  return {
    create: jest.fn((value: Partial<T>) => value as T),
    save: jest.fn(async (value: T) => ({ ...value, id: value.id ?? 'generated-id' })),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
  };
}

function attachRealtimePrompts(service: InterviewsService) {
  const prompts = {
    render: jest.fn((code: string, vars: Record<string, unknown>) =>
      [
        code,
        'You are Alex, a realistic professional interviewer for SkillBridge.',
        vars.language_instruction,
        vars.difficulty_instruction,
        code === 'interview_realtime_voice_v1'
          ? 'Live Realtime mode: the app owns the official question sequence. Read only the official question text sent by the app. Do not invent, reorder, skip, or close official questions. If the candidate asks for answers, refuse briefly and redirect back to the current interview question.'
          : 'Guided Voice mode: the app owns the official question sequence.',
        vars.context_block,
      ]
        .filter(Boolean)
        .join('\n\n'),
    ),
  };
  Object.assign(service, { prompts });
  return prompts;
}

function defaultInsight() {
  return {
    talking_point: 'project',
    relevance: 76,
    clarity: 'clear',
    off_topic: false,
    confidence_tone: 'calibrated',
    evidence_quality: 'moderate',
    note: 'Specific answer.',
    has_specific_example: true,
    star_present: { situation: true, task: true, action: true, result: false },
  };
}

describe('InterviewsService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const cvId = '22222222-2222-4222-8222-222222222222';
  const matchId = '33333333-3333-4333-8333-333333333333';
  const jdId = '44444444-4444-4444-8444-444444444444';

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders live voice instructions through PromptsService', () => {
    const prompts = {
      render: jest.fn().mockReturnValue('rendered realtime voice instructions'),
    };
    const service = new InterviewsService(
      repo<InterviewSessionEntity>() as never,
      repo<InterviewTurnEntity>() as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { get: jest.fn() } as never,
      prompts as never,
    );
    const session = {
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      targetRole: 'frontend_developer',
      contextSnapshot: {
        interviewDifficulty: {
          level: 'junior',
          source: 'target role',
          note: 'Use a junior-friendly baseline.',
        },
      },
    } as unknown as InterviewSessionEntity;

    const result = (
      service as unknown as {
        realtimeInstructions: (value: InterviewSessionEntity, context?: string) => string;
      }
    ).realtimeInstructions(session, 'Compact interview context');

    expect(result).toBe('rendered realtime voice instructions');
    expect(prompts.render).toHaveBeenCalledWith(
      'interview_realtime_voice_v1',
      expect.objectContaining({
        context: 'Compact interview context',
        interview_type: 'TECHNICAL',
        language: 'vi',
        language_instruction: expect.stringContaining('Vietnamese'),
        target_role: 'frontend_developer',
        difficulty_instruction: expect.stringContaining('junior'),
      }),
    );
  });

  it('limits the default history page to 10 sessions', async () => {
    const sessions = repo<InterviewSessionEntity>();
    sessions.findAndCount.mockResolvedValue([[], 0]);
    const service = new InterviewsService(
      sessions as never,
      repo<InterviewTurnEntity>() as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const response = await service.list(userId, {} as never);

    expect(sessions.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10 }),
    );
    expect(response).toEqual({ items: [], total: 0, page: 1, limit: 10 });
  });

  it('starts a CV/JD-backed hybrid interview session and stores the first turn', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const cvs = repo<CvEntity>();
    const matches = repo<CvMatchEntity>();
    const jds = repo<JobDescriptionEntity>();
    const interviewAi = { start: jest.fn() };
    const entitlements = {
      assertCanUse: jest.fn(async () => undefined),
      recordUsage: jest.fn(async () => undefined),
      getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
    };
    const realtime = {
      createClientSecret: jest.fn(async () => ({
        enabled: true,
        provider: 'openai',
        model: 'gpt-realtime-2',
        clientSecret: 'eph_secret',
        expiresAt: null,
      })),
    };

    cvs.findOne.mockResolvedValue({
      id: cvId,
      userId,
      title: 'Frontend CV',
      parsedText: 'React, TypeScript, internship project.',
      targetRole: 'frontend_developer',
      deletedAt: null,
    });
    matches.findOne.mockResolvedValue({
      id: matchId,
      cvId,
      jobDescriptionId: jdId,
      strengths: [{ skill: 'React' }],
      weaknesses: [{ skill: 'Testing' }],
      suggestions: { missing_skills: [{ skill: 'Testing' }] },
    });
    jds.findOne.mockResolvedValue({
      id: jdId,
      userId,
      title: 'Frontend Intern',
      rawText: 'React, TypeScript, testing, teamwork.',
    });
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: 'turn-1',
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
    }));
    const cvMatches = {
      getInterviewFocusAreas: jest.fn(async () => [
        {
          skill_canonical: 'testing',
          display_name: 'Testing',
          focus_type: 'gap_probe',
          reason: 'JD requires testing evidence.',
          difficulty: 'applied',
          template_question: 'How do you test React components in practice?',
        },
      ]),
    };

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      cvs as never,
      matches as never,
      jds as never,
      interviewAi as never,
      entitlements as never,
      realtime as never,
      undefined,
      cvMatches as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => (key === 'llm.openai.ttsVoice' ? 'cedar' : undefined)),
      } as never,
    );
    attachRealtimePrompts(service);

    const response = await service.start(userId, {
      cvId,
      cvMatchId: matchId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      voice: 'coral',
      speechSpeed: 1.3,
    });

    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: 'coral',
        speechSpeed: 1.3,
      }),
    );
    expect(entitlements.assertCanUse).toHaveBeenCalledWith(
      userId,
      BillingFeatureKey.INTERVIEW_SESSION,
    );
    expect(interviewAi.start).not.toHaveBeenCalled();
    expect(cvMatches.getInterviewFocusAreas).toHaveBeenCalledWith(userId, matchId, 'vi');
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agenda: expect.objectContaining({ turn_budget: 10 }),
        interviewState: expect.objectContaining({
          current_topic_id: 'screening-1',
          turns_used: 0,
          running_notes: [],
        }),
      }),
    );
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        turnOrder: 1,
        phase: 'SCREENING',
        topicPhase: 'SCREENING',
        interviewerQuestion:
          'To start, what have you been working on recently, and what drew you to this role?',
        aiRequestId: null,
      }),
    );
    expect(entitlements.recordUsage).toHaveBeenCalledWith(
      userId,
      BillingFeatureKey.INTERVIEW_SESSION,
      { sourceType: 'interview_session', sourceId: 'session-1' },
    );
    expect(response).toMatchObject({
      id: 'session-1',
      cvId,
      cvMatchId: matchId,
      jobDescriptionId: jdId,
      targetRole: 'frontend_developer',
      mode: 'HYBRID',
      status: 'IN_PROGRESS',
      maxDurationSeconds: 600,
      firstQuestion:
        'To start, what have you been working on recently, and what drew you to this role?',
      phase: 'SCREENING',
      realtime: { enabled: true, clientSecret: 'eph_secret' },
    });
    expect(response.expiresAt).toBeTruthy();
    expect(realtime.createClientSecret).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ id: 'session-1' }),
      expect.not.stringContaining('Candidate CV excerpt'),
    );
  });

  it('uses a DB question bank item for the first guided interview turn', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const questionBank = repo<InterviewQuestionBankItemEntity>();
    const entitlements = {
      assertCanUse: jest.fn(async () => undefined),
      recordUsage: jest.fn(async () => undefined),
      getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-bank-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: 'turn-bank-1',
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
    }));
    questionBank.find.mockResolvedValue([
      {
        id: 'bank-screening-vi',
        questionKey: 'backend-common-screening-01',
        language: 'vi',
        targetRole: 'backend_developer',
        interviewType: 'TECHNICAL',
        phase: 'SCREENING',
        skillCanonical: null,
        focusType: null,
        seniority: null,
        difficulty: 1,
        questionText: 'Hay gioi thieu du an backend gan nhat cua ban.',
        expectedSignals: ['specific_project'],
        rubricDimensions: ['technical_depth', 'evidence_credibility', 'communication'],
        sourceKind: 'authored_from_taxonomy',
        sourceUrl: 'https://www.onetcenter.org/database.html',
        sourceBasis: 'SkillBridge-authored from role taxonomy.',
        license: 'CC BY 4.0 + SkillBridge-authored',
        attribution: 'O*NET Resource Center; ESCO; SkillBridge authored wording.',
        reviewStatus: 'draft',
        priority: 50,
        active: true,
      },
    ]);

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      entitlements as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      questionBank as never,
    );
    attachRealtimePrompts(service);

    const response = await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    });

    expect(questionBank.find).toHaveBeenCalledWith({
      where: {
        active: true,
        language: 'vi',
        targetRole: 'backend_developer',
      },
      order: {
        priority: 'DESC',
        questionKey: 'ASC',
      },
    });
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewerQuestion: 'Hay gioi thieu du an backend gan nhat cua ban.',
        questionBankItemId: 'bank-screening-vi',
        questionBankKey: 'backend-common-screening-01',
      }),
    );
    expect(response.firstQuestion).toBe('Hay gioi thieu du an backend gan nhat cua ban.');
  });

  it('uses authored seed questions as a role fallback when the DB question bank is empty', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const questionBank = repo<InterviewQuestionBankItemEntity>();
    const entitlements = {
      assertCanUse: jest.fn(async () => undefined),
      recordUsage: jest.fn(async () => undefined),
      getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-seed-fallback-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: 'turn-seed-fallback-1',
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
    }));
    questionBank.find.mockResolvedValue([]);

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      entitlements as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      questionBank as never,
    );
    attachRealtimePrompts(service);

    const response = await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    });

    const createdSession = sessions.create.mock.calls[0][0] as InterviewSessionEntity;
    const agenda = createdSession.agenda as { topics: Array<{ phase: string }> };
    expect(agenda.topics.length).toBeGreaterThan(3);
    expect(agenda.topics.map((topic) => topic.phase)).toEqual(
      expect.arrayContaining(['SKILL_PROBE', 'SCENARIO', 'BEHAVIORAL']),
    );
    expect(agenda.topics.map((topic) => topic.phase)).not.toContain('WRAP');
    expect(agenda.topics.map((topic) => topic.phase)).not.toContain('JD_REQUIREMENT');
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        questionBankKey: expect.stringMatching(/^backend_developer\./),
      }),
    );
    expect(response.firstQuestion).toBeTruthy();
    expect(response.totalQuestionsPlanned).toBe(10);
  });

  it('marks role-only sessions explicitly and avoids CV/JD-specific question wording', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const questionBank = repo<InterviewQuestionBankItemEntity>();
    const entitlements = {
      assertCanUse: jest.fn(async () => undefined),
      recordUsage: jest.fn(async () => undefined),
      getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-role-only-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: 'turn-role-only-1',
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
    }));
    questionBank.find.mockResolvedValue([]);

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      entitlements as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      questionBank as never,
    );
    attachRealtimePrompts(service);

    const response = await service.start(userId, {
      targetRole: 'data_analyst',
      language: 'en',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    });

    const createdSession = sessions.create.mock.calls[0][0] as InterviewSessionEntity;
    const snapshot = createdSession.contextSnapshot as { contextMode?: string };
    const agenda = createdSession.agenda as { topics: Array<{ seed_question: string }> };
    const allQuestions = agenda.topics.map((topic) => topic.seed_question).join('\n');

    expect(response.contextMode).toBe('ROLE_ONLY');
    expect(snapshot.contextMode).toBe('ROLE_ONLY');
    expect(allQuestions).not.toMatch(/\bCV\b|resume|job description|\bJD\b|gap/i);
    expect(response.firstQuestion).toBeTruthy();
  });

  it('marks CV-only sessions explicitly and avoids JD/gap-specific fallback wording', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const cvs = repo<CvEntity>();
    const questionBank = repo<InterviewQuestionBankItemEntity>();
    const entitlements = {
      assertCanUse: jest.fn(async () => undefined),
      recordUsage: jest.fn(async () => undefined),
      getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-cv-only-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: 'turn-cv-only-1',
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
    }));
    cvs.findOne.mockResolvedValue({
      id: cvId,
      userId,
      title: 'Backend CV',
      targetRole: 'backend_developer',
      parsedText: 'Built REST APIs with PostgreSQL and queue workers.',
    } as CvEntity);
    questionBank.find.mockResolvedValue([]);

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      cvs as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      entitlements as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      questionBank as never,
    );
    attachRealtimePrompts(service);

    const response = await service.start(userId, {
      cvId,
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    });

    const createdSession = sessions.create.mock.calls[0][0] as InterviewSessionEntity;
    const snapshot = createdSession.contextSnapshot as { contextMode?: string };
    const agenda = createdSession.agenda as { topics: Array<{ seed_question: string; phase: string }> };
    const allQuestions = agenda.topics.map((topic) => topic.seed_question).join('\n');

    expect(response.contextMode).toBe('CV_ONLY');
    expect(snapshot.contextMode).toBe('CV_ONLY');
    expect(agenda.topics.map((topic) => topic.phase)).not.toContain('JD_REQUIREMENT');
    expect(allQuestions).not.toMatch(/job description|\bJD\b|gap/i);
    expect(response.firstQuestion).toBeTruthy();
  });

  it('loads a cvMatch by id, verifies ownership through its CV, and stores CV_JD_MATCH mode', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const cvs = repo<CvEntity>();
    const matches = repo<CvMatchEntity>();
    const jds = repo<JobDescriptionEntity>();
    const entitlements = {
      assertCanUse: jest.fn(async () => undefined),
      recordUsage: jest.fn(async () => undefined),
      getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-match-only-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: 'turn-match-only-1',
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
    }));
    matches.findOne.mockResolvedValue({
      id: matchId,
      cvId,
      jobDescriptionId: jdId,
      strengths: [],
      weaknesses: [],
      suggestions: {},
    });
    cvs.findOne.mockResolvedValue({
      id: cvId,
      userId,
      title: 'Backend CV',
      parsedText: 'Node.js and Postgres project.',
      deletedAt: null,
    });
    jds.findOne.mockResolvedValue({
      id: jdId,
      userId,
      title: 'Backend JD',
      rawText: 'Need REST API and database design.',
    });
    const cvMatches = {
      getInterviewFocusAreas: jest.fn(async () => []),
    };

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      cvs as never,
      matches as never,
      jds as never,
      { start: jest.fn() } as never,
      entitlements as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      cvMatches as never,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    attachRealtimePrompts(service);

    const response = await service.start(userId, {
      cvMatchId: matchId,
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    });

    expect(matches.findOne).toHaveBeenCalledWith({ where: { id: matchId } });
    expect(cvs.findOne).toHaveBeenCalledWith({
      where: { id: cvId, userId, deletedAt: expect.anything() },
    });
    expect(response).toMatchObject({
      cvId,
      cvMatchId: matchId,
      contextMode: 'CV_JD_MATCH',
    });
  });

  it('continues interview creation when question bank lookup fails', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const questionBank = repo<InterviewQuestionBankItemEntity>();
    const realtime = {
      createClientSecret: jest.fn(async () => ({
        enabled: true,
        provider: 'openai',
        model: 'gpt-realtime-2',
        clientSecret: 'live_secret',
        expiresAt: null,
      })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-live-bank-fallback-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    questionBank.find.mockRejectedValue(new Error('db unavailable'));

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      {
        assertCanUse: jest.fn(async () => undefined),
        recordUsage: jest.fn(async () => undefined),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      } as never,
      realtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      questionBank as never,
    );

    attachRealtimePrompts(service);
    const response = await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
    });

    expect(response.id).toBe('session-live-bank-fallback-1');
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-live-bank-fallback-1',
        turnOrder: 1,
        phase: 'SCREENING',
        interviewerQuestion:
          'To start, what have you been working on recently, and what drew you to this role?',
      }),
    );
    expect(response.firstQuestion).toBe(
      'To start, what have you been working on recently, and what drew you to this role?',
    );
    expect(realtime.createClientSecret).toHaveBeenCalled();
  });

  it('starts a live VOICE interview with a server-owned first turn', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:00:00.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { start: jest.fn() };
    const entitlements = {
      assertCanUse: jest.fn(async () => undefined),
      recordUsage: jest.fn(async () => undefined),
      getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
    };
    const realtime = {
      createClientSecret: jest.fn(async () => ({
        enabled: true,
        provider: 'openai',
        model: 'gpt-realtime-2',
        clientSecret: 'live_secret',
        expiresAt: null,
      })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-live-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      entitlements as never,
      realtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => (key === 'llm.openai.ttsVoice' ? 'cedar' : undefined)),
      } as never,
    );
    attachRealtimePrompts(service);

    const response = await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
    });

    expect(interviewAi.start).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: 'cedar',
      }),
    );
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-live-1',
        turnOrder: 1,
        phase: 'SCREENING',
        topicPhase: 'SCREENING',
        interviewerMessage:
          'Chúng ta bắt đầu bằng một câu tổng quan để tôi hiểu bối cảnh làm việc gần đây của bạn.',
        interviewerQuestion:
          'To start, what have you been working on recently, and what drew you to this role?',
      }),
    );
    expect(realtime.createClientSecret).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ id: 'session-live-1', mode: 'VOICE' }),
      expect.stringContaining('the app owns the official question sequence'),
    );
    const instructions = (realtime.createClientSecret as jest.Mock).mock.calls[0][2] as string;
    expect(instructions).toContain('Do not invent, reorder, skip, or close official questions');
    expect(instructions).toContain('Read only the official question text sent by the app');
    expect(instructions).toContain('If the candidate asks for answers');
    expect(instructions).toContain('redirect back to the current interview question');
    expect(instructions).toContain('Candidate seniority level: junior');
    expect(instructions).toContain(
      'No explicit seniority signal was found; use a junior-friendly baseline',
    );
    expect(response).toMatchObject({
      id: 'session-live-1',
      mode: 'VOICE',
      status: 'IN_PROGRESS',
      totalQuestionsPlanned: 10,
      firstMessage: 'Chúng ta bắt đầu bằng một câu tổng quan để tôi hiểu bối cảnh làm việc gần đây của bạn.',
      firstQuestion:
        'To start, what have you been working on recently, and what drew you to this role?',
      phase: 'SCREENING',
      realtime: { enabled: true, clientSecret: 'live_secret' },
    });
  });

  it('uses DB question bank metadata for live VOICE server-owned turns', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const questionBank = repo<InterviewQuestionBankItemEntity>();
    const realtime = {
      createClientSecret: jest.fn(async () => ({
        enabled: true,
        provider: 'openai',
        model: 'gpt-realtime-2',
        clientSecret: 'live_secret',
        expiresAt: null,
      })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-live-bank-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    questionBank.find.mockResolvedValue([
      {
        id: 'bank-voice-1',
        questionKey: 'backend-common-screening-01',
        language: 'vi',
        targetRole: 'backend_developer',
        interviewType: 'TECHNICAL',
        phase: 'SCREENING',
        skillCanonical: null,
        focusType: null,
        seniority: null,
        difficulty: 1,
        questionText: 'Hay mo dau bang du an backend gan nhat cua ung vien.',
        expectedSignals: ['specific_project'],
        rubricDimensions: ['technical_depth', 'evidence_credibility', 'communication'],
        sourceKind: 'authored_from_taxonomy',
        sourceUrl: 'https://www.onetcenter.org/database.html',
        sourceBasis: 'SkillBridge-authored from role taxonomy.',
        license: 'CC BY 4.0 + SkillBridge-authored',
        attribution: 'O*NET Resource Center; ESCO; SkillBridge authored wording.',
        reviewStatus: 'draft',
        priority: 50,
        active: true,
      },
    ]);

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      {
        assertCanUse: jest.fn(async () => undefined),
        recordUsage: jest.fn(async () => undefined),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      } as never,
      realtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      questionBank as never,
    );
    attachRealtimePrompts(service);

    await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
    });

    const instructions = (realtime.createClientSecret as jest.Mock).mock.calls[0][2] as string;
    expect(instructions).toContain('the app owns the official question sequence');
    expect(instructions).not.toContain('Curated question anchors');
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewerQuestion: 'Hay mo dau bang du an backend gan nhat cua ung vien.',
        questionBankItemId: 'bank-voice-1',
        questionBankKey: 'backend-common-screening-01',
      }),
    );
  });

  it('calibrates live interview difficulty from an explicit fresher target role without a JD', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const realtime = {
      createClientSecret: jest.fn(async () => ({
        enabled: true,
        provider: 'openai',
        model: 'gpt-realtime-2',
        clientSecret: 'live_secret',
        expiresAt: null,
      })),
    };
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: 'session-fresher-1',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      {
        assertCanUse: jest.fn(async () => undefined),
        recordUsage: jest.fn(async () => undefined),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      } as never,
      realtime as never,
    );
    attachRealtimePrompts(service);

    await service.start(userId, {
      targetRole: 'Fresher Backend Developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
    });

    const instructions = (realtime.createClientSecret as jest.Mock).mock.calls[0][2] as string;
    expect(instructions).toContain('Candidate seniority level: fresher');
    expect(instructions).toContain('Start with fundamentals, school/internship/personal projects');
    expect(instructions).toContain(
      'Do not ask senior-level architecture, distributed systems, incident leadership',
    );
    expect(instructions).toContain('Seniority evidence source: target role');
  });

  it('refreshes realtime tokens without nesting the interviewer instructions as context', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:05:00.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const realtime = {
      createClientSecret: jest.fn(async () => ({
        enabled: true,
        provider: 'openai',
        model: 'gpt-realtime-2',
        clientSecret: 'fresh_secret',
        expiresAt: null,
      })),
    };
    const service = new InterviewsService(
      sessions as never,
      repo<InterviewTurnEntity>() as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      realtime as never,
    );
    attachRealtimePrompts(service);
    sessions.findOne.mockResolvedValue({
      id: 'session-1',
      userId,
      cvId,
      jobDescriptionId: jdId,
      cvMatchId: matchId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2099-06-12T00:10:00.000Z'),
      maxDurationSeconds: 600,
      contextSnapshot: {
        cv: { id: cvId, title: 'Frontend CV', targetRole: 'frontend_developer' },
        jobDescription: { id: jdId, title: 'Frontend Intern', sourceType: 'manual' },
        cvMatch: {
          id: matchId,
          overallScore: 72,
          strengths: [{ skill: 'React' }],
          weaknesses: [{ skill: 'Testing' }],
        },
        targetRole: 'frontend_developer',
      },
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    sessions.save.mockImplementation(async (value) => value);

    await service.createRealtimeToken(userId, 'session-1');

    const instructions = (realtime.createClientSecret as jest.Mock).mock.calls[0][2] as string;
    expect(instructions).toContain('You are Alex');
    expect(instructions).toContain('Speak and respond only in Vietnamese');
    expect(instructions).toContain('Frontend Intern');
    expect(instructions).toContain('Testing');
    expect(instructions).not.toContain('Context:\nYou are Alex');
  });

  it('creates question audio from the current interviewer bridge and pending question', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:05:00.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const questionAudio = {
      createQuestionAudio: jest.fn(async () => ({
        data: Buffer.from('audio'),
        contentType: 'audio/mpeg',
      })),
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      questionAudio as never,
    );
    const session = {
      id: 'session-1',
      userId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2099-06-12T00:10:00.000Z'),
      maxDurationSeconds: 600,
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    } as InterviewSessionEntity;
    const pendingTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      turnOrder: 1,
      interviewerMessage: 'Bridge before the question.',
      interviewerQuestion: 'Bạn hãy giới thiệu dự án React gần nhất.',
      userAnswerText: null,
    } as InterviewTurnEntity;
    sessions.findOne.mockResolvedValue(session);
    turns.findOne.mockResolvedValue(pendingTurn);

    const response = await service.createQuestionAudio(userId, 'session-1');

    expect(questionAudio.createQuestionAudio).toHaveBeenCalledWith(
      userId,
      session,
      expect.stringContaining('Bridge before the question.'),
    );
    expect(response.contentType).toBe('audio/mpeg');
  });

  it('uses a 15 minute duration limit for premium interview sessions', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:00:00.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      {
        start: jest.fn(async () => ({
          ai_request_id: 'ai-start-1',
          first_message: 'Ready.',
          first_question: 'Tell me about your strongest project.',
          phase: 'INTRODUCTION',
          total_questions_planned: 7,
          token_usage: 120,
        })),
      } as never,
      {
        assertCanUse: jest.fn(async () => undefined),
        recordUsage: jest.fn(async () => undefined),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PREMIUM' })),
      } as never,
      {
        createClientSecret: jest.fn(async () => ({
          enabled: false,
          provider: 'openai',
          model: null,
          clientSecret: null,
          expiresAt: null,
        })),
      } as never,
    );
    sessions.save.mockImplementation(async (value) => ({
      ...value,
      id: value.id ?? 'session-premium',
      createdAt: value.createdAt ?? new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: null,
    }));
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: 'turn-1',
      askedAt: new Date('2026-06-12T00:00:01.000Z'),
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
    }));

    const response = await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    });

    expect(response.maxDurationSeconds).toBe(900);
    expect(response.expiresAt).toBe('2026-06-12T00:15:00.000Z');
  });

  it('rejects a CV/JD match that does not belong to the selected CV', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const cvs = repo<CvEntity>();
    const matches = repo<CvMatchEntity>();
    const jds = repo<JobDescriptionEntity>();
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      cvs as never,
      matches as never,
      jds as never,
      { start: jest.fn() } as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
    );

    cvs.findOne.mockResolvedValue({ id: cvId, userId, parsedText: 'CV text', deletedAt: null });
    matches.findOne.mockResolvedValue(null);

    await expect(
      service.start(userId, {
        cvId,
        cvMatchId: matchId,
        targetRole: 'frontend_developer',
        language: 'vi',
        mode: 'HYBRID',
        interviewType: 'TECHNICAL',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('records an answer and creates the next turn', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { answer: jest.fn() };
    const chain = {
      assess: jest.fn(async () => ({
        aiRequestId: 'ai-assess-1',
        score: 76,
        recognizedConcepts: ['React Query'],
        depthSignal: 'adequate',
        claimStatus: 'partial',
        currentThread: 'React Query cache invalidation',
        gapsRevealed: [
          'Shallow on React Query cache invalidation triggers',
          'No mention of Kafka partitioning',
        ],
        note: 'Mentioned cache invalidation.',
      })),
      ask: jest.fn(async () => ({
        aiRequestId: 'ai-ask-1',
        aiMessage: 'Cảm ơn bạn, mình hỏi tiếp nhé.',
        question: 'Bạn xử lý stale server state trong React như thế nào?',
      })),
    };
    const insight = {
      talking_point: 'project',
      relevance: 78,
      clarity: 'clear',
      off_topic: false,
      confidence_tone: 'calibrated',
      evidence_quality: 'thin',
      note: 'Needs a concrete metric.',
      has_specific_example: false,
      star_present: { situation: true, task: true, action: true, result: false },
    };
    const answerInsight = { judge: jest.fn(async () => insight) };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      chain as never,
      answerInsight as never,
      {} as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-1',
      userId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      agenda: {
        turn_budget: 10,
        uncovered: [],
        topics: [
          {
            id: 'topic-react',
            phase: 'JD_REQUIREMENT',
            skill_canonical: 'react',
            display_name: 'React Query',
            seniority_target: 'mid',
            drill_budget: 3,
            what_to_probe: 'React Query cache invalidation',
            seed_question: 'How do you use React Query?',
          },
          {
            id: 'wrap-1',
            phase: 'WRAP',
            skill_canonical: null,
            display_name: 'Wrap-up',
            seniority_target: 'mid',
            drill_budget: 1,
            what_to_probe: 'close',
            seed_question: 'Anything to add?',
          },
        ],
      },
      interviewState: {
        current_phase: 'JD_REQUIREMENT',
        current_topic_id: 'topic-react',
        drill_depth: 0,
        current_thread: 'React Query',
        running_notes: [],
        covered_topic_ids: [],
        uncovered_topic_ids: [],
        turns_used: 0,
        evasive_streak: 0,
      },
    });
    const pendingTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      turnOrder: 1,
      phase: 'JD_REQUIREMENT',
      topicPhase: 'JD_REQUIREMENT',
      skillCanonical: 'react',
      currentThread: 'React Query',
      modality: 'AUDIO',
      interviewerQuestion: 'How do you use React Query?',
      userAnswerText: null,
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
      askedAt: new Date('2026-06-12T00:00:01.000Z'),
    };
    turns.find.mockResolvedValue([]);
    turns.findOne
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity)
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity);
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: value.id ?? 'turn-2',
      askedAt: new Date('2026-06-12T00:01:00.000Z'),
      createdAt: new Date('2026-06-12T00:01:00.000Z'),
    }));

    const response = await service.answer(userId, {
      sessionId: 'session-1',
      userAnswer: 'Em dùng React Query để cache và invalidate theo mutation.',
      userTranscript: 'Em dùng React Query để cache...',
      modality: 'AUDIO',
      durationSeconds: 42,
    });

    expect(interviewAi.answer).not.toHaveBeenCalled();
    expect(chain.assess).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        sessionId: 'session-1',
        turnOrder: 1,
        targetDimension: 'technical_depth',
        currentThread: 'React Query',
      }),
    );
    expect(answerInsight.judge).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: 'Em dùng React Query để cache và invalidate theo mutation.',
        question: 'How do you use React Query?',
        target_dimension: 'technical_depth',
      }),
      userId,
    );
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'turn-1',
        userAnswerText: 'Em dùng React Query để cache và invalidate theo mutation.',
        userAnswerTranscript: 'Em dùng React Query để cache...',
        perQuestionScore: '76.00',
        depthSignal: 'adequate',
        strengths: ['React Query'],
        // the fabricated off-topic Kafka gap is dropped by topic-universe grounding
        improvements: ['Shallow on React Query cache invalidation triggers'],
        signals: expect.objectContaining({
          jd_term_hits: expect.objectContaining({ hit: expect.arrayContaining(['React Query']) }),
        }),
        insight,
        currentThread: 'React Query cache invalidation',
        skillCanonical: 'react',
      }),
    );
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewState: expect.objectContaining({
          current_topic_id: 'topic-react',
          drill_depth: 1,
          turns_used: 1,
          running_notes: ['Mentioned cache invalidation.'],
        }),
      }),
    );
    expect(response.nextTurn).toMatchObject({
      sessionId: 'session-1',
      turnOrder: 2,
      interviewerQuestion: 'Bạn xử lý stale server state trong React như thế nào?',
      aiRequestId: 'ai-ask-1',
    });
    expect(response.finished).toBe(false);
  });

  it('does not finish after the second answer while planned fallback topics remain', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { answer: jest.fn() };
    const chain = {
      assess: jest.fn(async () => ({
        aiRequestId: 'ai-assess-2',
        score: 72,
        recognizedConcepts: ['REST API'],
        depthSignal: 'adequate',
        claimStatus: 'ok',
        currentThread: 'REST API ownership',
        gapsRevealed: [],
        note: 'Answered with a concrete API example.',
      })),
      ask: jest.fn(async () => ({
        aiRequestId: 'ai-ask-2',
        aiMessage: 'Thanks, moving to the next area.',
        question: 'Let us connect that API work to data design: how did you model the schema?',
      })),
    };
    const insight = {
      talking_point: 'project',
      relevance: 76,
      clarity: 'clear',
      off_topic: false,
      confidence_tone: 'calibrated',
      evidence_quality: 'moderate',
      note: 'Specific API example.',
      has_specific_example: true,
      star_present: { situation: true, task: true, action: true, result: false },
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      chain as never,
      { judge: jest.fn(async () => insight) } as never,
      {} as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-fallback-answer-1',
      userId,
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      agenda: {
        turn_budget: 10,
        uncovered: [],
        topics: [
          {
            id: 'screening-1',
            phase: 'SCREENING',
            skill_canonical: null,
            display_name: 'Motivation',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'warm up',
            seed_question: 'Tell me about recent backend work.',
          },
          {
            id: 'topic-1-rest-api',
            phase: 'JD_REQUIREMENT',
            skill_canonical: 'rest_api',
            display_name: 'REST API',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'REST API ownership',
            seed_question: 'Describe a REST API you built.',
            question_bank_item_id: 'seed:backend_developer.skill.01:en',
            question_bank_key: 'backend_developer.skill.01',
          },
          {
            id: 'topic-2-database-design',
            phase: 'JD_REQUIREMENT',
            skill_canonical: 'database_design',
            display_name: 'Database Design',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'schema and tradeoffs',
            seed_question: 'Describe how you designed a database schema.',
            question_bank_item_id: 'seed:backend_developer.skill.04:en',
            question_bank_key: 'backend_developer.skill.04',
          },
          {
            id: 'wrap-1',
            phase: 'WRAP',
            skill_canonical: null,
            display_name: 'Wrap-up',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'close',
            seed_question: 'Anything to add?',
          },
        ],
      },
      interviewState: {
        current_phase: 'JD_REQUIREMENT',
        current_topic_id: 'topic-1-rest-api',
        drill_depth: 0,
        current_thread: 'REST API ownership',
        running_notes: [],
        covered_topic_ids: ['screening-1'],
        uncovered_topic_ids: [],
        turns_used: 1,
        evasive_streak: 0,
      },
    });
    const pendingTurn = {
      id: 'turn-2',
      sessionId: 'session-fallback-answer-1',
      turnOrder: 2,
      phase: 'JD_REQUIREMENT',
      topicPhase: 'JD_REQUIREMENT',
      skillCanonical: 'rest_api',
      currentThread: 'REST API ownership',
      modality: 'AUDIO',
      interviewerQuestion: 'Describe a REST API you built.',
      userAnswerText: null,
      createdAt: new Date('2026-06-12T00:00:02.000Z'),
      askedAt: new Date('2026-06-12T00:00:02.000Z'),
    };
    turns.find.mockResolvedValue([
      {
        id: 'turn-1',
        sessionId: 'session-fallback-answer-1',
        turnOrder: 1,
        interviewerQuestion: 'Tell me about recent backend work.',
        userAnswerText: 'I built APIs for an internal project.',
      },
    ]);
    turns.findOne
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity)
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity);
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: value.id ?? 'turn-3',
      askedAt: new Date('2026-06-12T00:02:00.000Z'),
      createdAt: new Date('2026-06-12T00:02:00.000Z'),
    }));

    const response = await service.answer(userId, {
      sessionId: 'session-fallback-answer-1',
      userAnswer: 'I designed REST endpoints, validation, auth checks, and error handling.',
      userTranscript: 'I designed REST endpoints, validation, auth checks, and error handling.',
      modality: 'AUDIO',
      durationSeconds: 50,
    });

    expect(response.finished).toBe(false);
    expect(chain.ask).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        decision: 'advance',
        currentTopic: expect.objectContaining({ id: 'topic-2-database-design' }),
      }),
    );
    expect(response.nextTurn).toMatchObject({
      turnOrder: 3,
      interviewerMessage: 'Thanks, moving to the next area.',
      interviewerQuestion: 'Let us connect that API work to data design: how did you model the schema?',
      questionBankItemId: null,
      questionBankKey: null,
    });
    expect(response.turnDecision).toBe('advance_topic');
    expect(response.nextQuestionKind).toBe('transition');
    expect(response.session.status).toBe('IN_PROGRESS');
    expect(interviewAi.answer).not.toHaveBeenCalled();
  });

  it('does not finish just because the soft turn budget is reached while time remains', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { answer: jest.fn() };
    const chain = {
      assess: jest.fn(async () => ({
        aiRequestId: 'ai-assess-soft-budget',
        score: 74,
        recognizedConcepts: ['REST API'],
        depthSignal: 'adequate',
        claimStatus: 'ok',
        currentThread: 'REST API ownership',
        gapsRevealed: [],
        note: 'Answered with an API example.',
      })),
      ask: jest.fn(async () => ({
        aiRequestId: 'ai-ask-soft-budget',
        aiMessage: 'Let us connect that to data design.',
        question: 'What database trade-off did you make while building that API?',
      })),
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      chain as never,
      { judge: jest.fn(async () => defaultInsight()) } as never,
      {} as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-soft-budget-1',
      userId,
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2099-06-12T00:10:00.000Z'),
      agenda: {
        turn_budget: 6,
        uncovered: [],
        topics: [
          {
            id: 'topic-rest-api',
            phase: 'SKILL_PROBE',
            skill_canonical: 'rest_api',
            display_name: 'REST API',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'REST API ownership',
            seed_question: 'Describe a REST API you built.',
          },
          {
            id: 'topic-database-design',
            phase: 'SKILL_PROBE',
            skill_canonical: 'database_design',
            display_name: 'Database Design',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'schema tradeoffs',
            seed_question: 'Describe how you designed a database schema.',
          },
        ],
      },
      interviewState: {
        current_phase: 'SKILL_PROBE',
        current_topic_id: 'topic-rest-api',
        drill_depth: 0,
        current_thread: 'REST API ownership',
        running_notes: [],
        covered_topic_ids: ['screening-1', 'topic-a', 'topic-b', 'topic-c', 'topic-d'],
        uncovered_topic_ids: [],
        turns_used: 5,
        evasive_streak: 0,
      },
    });
    const pendingTurn = {
      id: 'turn-soft-budget-6',
      sessionId: 'session-soft-budget-1',
      turnOrder: 6,
      phase: 'SKILL_PROBE',
      topicPhase: 'SKILL_PROBE',
      skillCanonical: 'rest_api',
      currentThread: 'REST API ownership',
      modality: 'AUDIO',
      interviewerQuestion: 'Describe a REST API you built.',
      userAnswerText: null,
      createdAt: new Date('2026-06-12T00:05:00.000Z'),
      askedAt: new Date('2026-06-12T00:05:00.000Z'),
    };
    turns.find.mockResolvedValue([]);
    turns.findOne
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity)
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity);
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: value.id ?? 'turn-soft-budget-7',
      askedAt: new Date('2026-06-12T00:06:00.000Z'),
      createdAt: new Date('2026-06-12T00:06:00.000Z'),
    }));

    const response = await service.answer(userId, {
      sessionId: 'session-soft-budget-1',
      userAnswer: 'I built REST APIs with validation, auth, and transaction boundaries.',
      userTranscript: 'I built REST APIs with validation, auth, and transaction boundaries.',
      modality: 'AUDIO',
      durationSeconds: 40,
    });

    expect(response.finished).toBe(false);
    expect(chain.ask).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        decision: 'advance',
        currentTopic: expect.objectContaining({ id: 'topic-database-design' }),
      }),
    );
    expect(response.nextTurn).toMatchObject({
      turnOrder: 7,
      interviewerQuestion: 'What database trade-off did you make while building that API?',
      aiRequestId: 'ai-ask-soft-budget',
    });
    expect(response.turnDecision).toBe('advance_topic');
    expect(response.nextQuestionKind).toBe('transition');
    expect(response.finishReason).toBeNull();
    expect(response.session.status).toBe('IN_PROGRESS');
  });

  it('does not advance into a wrap topic before the closing time window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:05:00.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { answer: jest.fn() };
    const chain = {
      assess: jest.fn(async () => ({
        aiRequestId: 'ai-assess-no-early-wrap',
        score: 73,
        recognizedConcepts: ['React'],
        depthSignal: 'adequate',
        claimStatus: 'ok',
        currentThread: 'React component state',
        gapsRevealed: [],
        note: 'Explained React state.',
      })),
      ask: jest.fn(async () => ({
        aiRequestId: 'ai-ask-no-early-wrap',
        aiMessage: 'Thanks, I want to go a level deeper on state.',
        question: 'How do you decide between local state and server state?',
      })),
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      chain as never,
      { judge: jest.fn(async () => defaultInsight()) } as never,
      {} as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-no-early-wrap',
      userId,
      targetRole: 'frontend_developer',
      language: 'en',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2026-06-12T00:10:00.000Z'),
      maxDurationSeconds: 600,
      agenda: {
        turn_budget: 6,
        uncovered: [],
        topics: [
          {
            id: 'topic-react',
            phase: 'SKILL_PROBE',
            skill_canonical: 'react',
            display_name: 'React',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'React component state',
            seed_question: 'How do you manage state in React?',
          },
          {
            id: 'wrap-1',
            phase: 'WRAP',
            skill_canonical: null,
            display_name: 'Wrap-up',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'close',
            seed_question: 'Before we wrap up, anything else to add?',
          },
        ],
      },
      interviewState: {
        current_phase: 'SKILL_PROBE',
        current_topic_id: 'topic-react',
        drill_depth: 0,
        current_thread: 'React component state',
        running_notes: [],
        covered_topic_ids: [],
        uncovered_topic_ids: [],
        turns_used: 4,
        evasive_streak: 0,
      },
    });
    const pendingTurn = {
      id: 'turn-no-early-wrap',
      sessionId: 'session-no-early-wrap',
      turnOrder: 5,
      phase: 'SKILL_PROBE',
      topicPhase: 'SKILL_PROBE',
      skillCanonical: 'react',
      currentThread: 'React component state',
      modality: 'AUDIO',
      interviewerQuestion: 'How do you manage state in React?',
      userAnswerText: null,
      createdAt: new Date('2026-06-12T00:04:20.000Z'),
      askedAt: new Date('2026-06-12T00:04:20.000Z'),
    };
    turns.find.mockResolvedValue([]);
    turns.findOne
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity)
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity);
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: value.id ?? 'turn-no-early-wrap-next',
      askedAt: new Date('2026-06-12T00:05:30.000Z'),
      createdAt: new Date('2026-06-12T00:05:30.000Z'),
    }));

    const response = await service.answer(userId, {
      sessionId: 'session-no-early-wrap',
      userAnswer: 'I use local state for small UI details and React Query for server state.',
      userTranscript: 'I use local state for small UI details and React Query for server state.',
      modality: 'AUDIO',
      durationSeconds: 40,
    });

    expect(response.finished).toBe(false);
    expect(response.nextTurn).toMatchObject({
      topicPhase: 'SKILL_PROBE',
      interviewerMessage: 'Thanks, I want to go a level deeper on state.',
      interviewerQuestion: 'How do you decide between local state and server state?',
    });
    expect(response.nextQuestion).not.toContain('Before we wrap');
    expect(response.turnDecision).toBe('adaptive_follow_up');
    expect(response.nextQuestionKind).toBe('follow_up');
    expect(response.finishReason).toBeNull();
  });

  it('asks one closing prompt inside the closing time window without ending immediately', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:08:45.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const chain = {
      assess: jest.fn(async () => ({
        aiRequestId: 'ai-assess-closing-window',
        score: 71,
        recognizedConcepts: ['React'],
        depthSignal: 'adequate',
        claimStatus: 'ok',
        currentThread: 'React state',
        gapsRevealed: [],
        note: 'Answered before closing.',
      })),
      ask: jest.fn(async () => ({
        aiRequestId: 'ai-ask-closing-window',
        aiMessage: 'We are nearly out of time, so I will make this the last one.',
        question: 'Is there any frontend project or strength you want to add briefly?',
      })),
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { answer: jest.fn() } as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      chain as never,
      { judge: jest.fn(async () => defaultInsight()) } as never,
      {} as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-closing-window',
      userId,
      targetRole: 'frontend_developer',
      language: 'en',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2026-06-12T00:10:00.000Z'),
      maxDurationSeconds: 600,
      agenda: {
        turn_budget: 6,
        uncovered: [],
        topics: [
          {
            id: 'topic-react',
            phase: 'SKILL_PROBE',
            skill_canonical: 'react',
            display_name: 'React',
            seniority_target: 'junior',
            drill_budget: 2,
            what_to_probe: 'React state',
            seed_question: 'How do you manage state in React?',
          },
        ],
      },
      interviewState: {
        current_phase: 'SKILL_PROBE',
        current_topic_id: 'topic-react',
        drill_depth: 0,
        current_thread: 'React state',
        running_notes: [],
        covered_topic_ids: [],
        uncovered_topic_ids: [],
        turns_used: 3,
        evasive_streak: 0,
      },
    });
    const pendingTurn = {
      id: 'turn-closing-window',
      sessionId: 'session-closing-window',
      turnOrder: 4,
      phase: 'SKILL_PROBE',
      topicPhase: 'SKILL_PROBE',
      skillCanonical: 'react',
      currentThread: 'React state',
      modality: 'AUDIO',
      interviewerQuestion: 'How do you manage state in React?',
      userAnswerText: null,
      createdAt: new Date('2026-06-12T00:08:20.000Z'),
      askedAt: new Date('2026-06-12T00:08:20.000Z'),
    };
    turns.find.mockResolvedValue([]);
    turns.findOne
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity)
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity);
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: value.id ?? 'turn-closing-window-next',
      askedAt: new Date('2026-06-12T00:08:50.000Z'),
      createdAt: new Date('2026-06-12T00:08:50.000Z'),
    }));

    const response = await service.answer(userId, {
      sessionId: 'session-closing-window',
      userAnswer: 'I used local state for form UI and React Query for server data.',
      userTranscript: 'I used local state for form UI and React Query for server data.',
      modality: 'AUDIO',
      durationSeconds: 25,
    });

    expect(response.finished).toBe(false);
    expect(chain.ask).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        decision: 'wrap',
        currentTopic: expect.objectContaining({ phase: 'WRAP' }),
      }),
    );
    expect(response.turnDecision).toBe('closing_prompt');
    expect(response.nextQuestionKind).toBe('closing');
    expect(response.finishReason).toBeNull();
    expect(response.nextTurn).toMatchObject({
      topicPhase: 'WRAP',
      interviewerMessage: 'We are nearly out of time, so I will make this the last one.',
      interviewerQuestion: 'Is there any frontend project or strength you want to add briefly?',
    });
  });

  it('finishes after a valid answer when too little time remains for another question', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:09:40.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const chain = {
      assess: jest.fn(async () => ({
        aiRequestId: 'ai-assess-time-limit',
        score: 70,
        recognizedConcepts: ['REST API'],
        depthSignal: 'adequate',
        claimStatus: 'ok',
        currentThread: 'REST API ownership',
        gapsRevealed: [],
        note: 'Answered near time limit.',
      })),
      ask: jest.fn(),
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { answer: jest.fn() } as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      chain as never,
      { judge: jest.fn(async () => defaultInsight()) } as never,
      {} as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-time-limit',
      userId,
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2026-06-12T00:10:00.000Z'),
      maxDurationSeconds: 600,
      agenda: {
        turn_budget: 6,
        uncovered: [],
        topics: [
          {
            id: 'topic-rest-api',
            phase: 'SKILL_PROBE',
            skill_canonical: 'rest_api',
            display_name: 'REST API',
            seniority_target: 'junior',
            drill_budget: 2,
            what_to_probe: 'REST API ownership',
            seed_question: 'Describe a REST API you built.',
          },
        ],
      },
      interviewState: {
        current_phase: 'SKILL_PROBE',
        current_topic_id: 'topic-rest-api',
        drill_depth: 0,
        current_thread: 'REST API ownership',
        running_notes: [],
        covered_topic_ids: [],
        uncovered_topic_ids: [],
        turns_used: 3,
        evasive_streak: 0,
      },
    });
    const pendingTurn = {
      id: 'turn-time-limit',
      sessionId: 'session-time-limit',
      turnOrder: 4,
      phase: 'SKILL_PROBE',
      topicPhase: 'SKILL_PROBE',
      skillCanonical: 'rest_api',
      currentThread: 'REST API ownership',
      modality: 'AUDIO',
      interviewerQuestion: 'Describe a REST API you built.',
      userAnswerText: null,
      createdAt: new Date('2026-06-12T00:09:10.000Z'),
      askedAt: new Date('2026-06-12T00:09:10.000Z'),
    };
    turns.find.mockResolvedValue([]);
    turns.findOne.mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity);
    turns.save.mockImplementation(async (value) => value);
    sessions.save.mockImplementation(async (value) => value);

    const response = await service.answer(userId, {
      sessionId: 'session-time-limit',
      userAnswer: 'I built REST APIs with validation, authentication, and transaction handling.',
      userTranscript: 'I built REST APIs with validation, authentication, and transaction handling.',
      modality: 'AUDIO',
      durationSeconds: 30,
    });

    expect(chain.ask).not.toHaveBeenCalled();
    expect(response.finished).toBe(true);
    expect(response.finishReason).toBe('TIME_LIMIT');
    expect(response.turnDecision).toBe('finish');
    expect(response.nextQuestionKind).toBeNull();
    expect(response.nextTurn).toBeNull();
    expect(response.nextQuestion).toBeNull();
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'COMPLETED',
        endedAt: new Date('2026-06-12T00:09:40.000Z'),
      }),
    );
  });

  it('continues with an adaptive follow-up when topics are exhausted but the safety cap is not reached', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { answer: jest.fn() };
    const chain = {
      assess: jest.fn(async () => ({
        aiRequestId: 'ai-assess-exhausted-topic',
        score: 78,
        recognizedConcepts: ['Monitoring'],
        depthSignal: 'adequate',
        claimStatus: 'ok',
        currentThread: 'production monitoring',
        gapsRevealed: [],
        note: 'Explained monitoring basics.',
      })),
      ask: jest.fn(async () => ({
        aiRequestId: 'ai-ask-exhausted-topic',
        aiMessage: 'Let me go one level deeper.',
        question: 'What signal would tell you the incident is getting worse?',
      })),
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      undefined,
      chain as never,
      { judge: jest.fn(async () => defaultInsight()) } as never,
      {} as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-exhausted-topic-1',
      userId,
      targetRole: 'devops_engineer',
      language: 'en',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2099-06-12T00:10:00.000Z'),
      agenda: {
        turn_budget: 6,
        uncovered: [],
        topics: [
          {
            id: 'topic-monitoring',
            phase: 'SKILL_PROBE',
            skill_canonical: 'monitoring',
            display_name: 'Monitoring',
            seniority_target: 'junior',
            drill_budget: 1,
            what_to_probe: 'production monitoring',
            seed_question: 'How do you monitor production health?',
          },
        ],
      },
      interviewState: {
        current_phase: 'SKILL_PROBE',
        current_topic_id: 'topic-monitoring',
        drill_depth: 0,
        current_thread: 'production monitoring',
        running_notes: [],
        covered_topic_ids: [],
        uncovered_topic_ids: [],
        turns_used: 5,
        evasive_streak: 0,
      },
    });
    const pendingTurn = {
      id: 'turn-exhausted-topic-6',
      sessionId: 'session-exhausted-topic-1',
      turnOrder: 6,
      phase: 'SKILL_PROBE',
      topicPhase: 'SKILL_PROBE',
      skillCanonical: 'monitoring',
      currentThread: 'production monitoring',
      modality: 'AUDIO',
      interviewerQuestion: 'How do you monitor production health?',
      userAnswerText: null,
      createdAt: new Date('2026-06-12T00:05:00.000Z'),
      askedAt: new Date('2026-06-12T00:05:00.000Z'),
    };
    turns.find.mockResolvedValue([]);
    turns.findOne
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity)
      .mockResolvedValueOnce(pendingTurn as unknown as InterviewTurnEntity);
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: value.id ?? 'turn-exhausted-topic-7',
      askedAt: new Date('2026-06-12T00:06:00.000Z'),
      createdAt: new Date('2026-06-12T00:06:00.000Z'),
    }));

    const response = await service.answer(userId, {
      sessionId: 'session-exhausted-topic-1',
      userAnswer: 'I watch latency, error rate, saturation, and alerts on deployment changes.',
      userTranscript: 'I watch latency, error rate, saturation, and alerts on deployment changes.',
      modality: 'AUDIO',
      durationSeconds: 45,
    });

    expect(response.finished).toBe(false);
    expect(chain.ask).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        decision: 'drill',
        currentTopic: expect.objectContaining({ id: 'topic-monitoring' }),
      }),
    );
    expect(response.nextTurn).toMatchObject({
      turnOrder: 7,
      interviewerQuestion: 'What signal would tell you the incident is getting worse?',
      aiRequestId: 'ai-ask-exhausted-topic',
    });
    expect(response.session.status).toBe('IN_PROGRESS');
  });

  it('limits answer history sent to the AI to the latest turns plus the current answer', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = {
      answer: jest.fn(async () => ({
        ai_request_id: 'ai-answer-1',
        ai_message: 'Thanks, next question.',
        next_question: 'What trade-off did you make?',
        phase: 'TECHNICAL_DEEP_DIVE',
        finished: false,
        per_question_score: 70,
        per_question_strengths: [],
        per_question_improvements: [],
      })),
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-1',
      userId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    const allTurns = Array.from({ length: 8 }, (_, index) => ({
      id: `turn-${index + 1}`,
      sessionId: 'session-1',
      turnOrder: index + 1,
      phase: 'TECHNICAL_DEEP_DIVE',
      modality: 'AUDIO' as const,
      interviewerQuestion: `Question ${index + 1}`,
      userAnswerText: index === 7 ? null : `Answer ${index + 1}`,
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
      askedAt: new Date('2026-06-12T00:00:01.000Z'),
    }));
    allTurns[4].userAnswerText = 'Email candidate@example.com or call 0987 654 321.';
    turns.find.mockImplementation(async (options?: { take?: number }) => {
      if (options?.take) return allTurns.slice(2, 7).reverse();
      return allTurns;
    });
    turns.findOne
      .mockResolvedValueOnce(allTurns[7] as InterviewTurnEntity)
      .mockResolvedValueOnce(allTurns[7] as InterviewTurnEntity);
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: value.id ?? 'turn-9',
      askedAt: new Date('2026-06-12T00:01:00.000Z'),
      createdAt: new Date('2026-06-12T00:01:00.000Z'),
    }));

    await service.answer(userId, {
      sessionId: 'session-1',
      userAnswer: 'Current answer from applicant@example.com and 0901 234 567.',
      modality: 'AUDIO',
    });

    expect(interviewAi.answer).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        question_history: [
          { order: 3, question: 'Question 3', answer: 'Answer 3' },
          { order: 4, question: 'Question 4', answer: 'Answer 4' },
          {
            order: 5,
            question: 'Question 5',
            answer: 'Email [redacted-email] or call [redacted-phone].',
          },
          { order: 6, question: 'Question 6', answer: 'Answer 6' },
          { order: 7, question: 'Question 7', answer: 'Answer 7' },
          {
            order: 8,
            question: 'Question 8',
            answer: 'Current answer from [redacted-email] and [redacted-phone].',
          },
        ],
        current_user_answer: 'Current answer from [redacted-email] and [redacted-phone].',
      }),
    );
  });

  it('blocks turn submission after the session time limit expires', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:10:01.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { answer: jest.fn() };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-1',
      userId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2026-06-12T00:10:00.000Z'),
      maxDurationSeconds: 600,
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    });

    await expect(
      service.answer(userId, {
        sessionId: 'session-1',
        userAnswer: 'Late answer',
        modality: 'TEXT',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(interviewAi.answer).not.toHaveBeenCalled();
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'COMPLETED',
        endedAt: new Date('2026-06-12T00:10:00.000Z'),
        durationSeconds: 600,
      }),
    );
  });

  it('cancels an unanswered session without requesting final AI scoring', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:02:00.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { end: jest.fn() };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-1',
      userId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    turns.find.mockResolvedValue([
      {
        id: 'turn-1',
        sessionId: 'session-1',
        turnOrder: 1,
        phase: 'INTRODUCTION',
        modality: 'AUDIO',
        interviewerQuestion: 'Introduce yourself.',
        userAnswerText: null,
        createdAt: new Date('2026-06-12T00:00:01.000Z'),
        askedAt: new Date('2026-06-12T00:00:01.000Z'),
      },
    ]);
    sessions.save.mockImplementation(async (value) => value);

    const response = await service.end(userId, { sessionId: 'session-1' });

    expect(interviewAi.end).not.toHaveBeenCalled();
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CANCELLED',
        endedAt: new Date('2026-06-12T00:02:00.000Z'),
        durationSeconds: 120,
      }),
    );
    expect(response.status).toBe('CANCELLED');
    expect(response.overallScore).toBeNull();
    expect(response.turns).toHaveLength(1);
  });

  it('persists reviewed live realtime turns before final scoring', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:04:00.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = {
      end: jest.fn(async () => ({
        ai_request_id: 'ai-live-end-1',
        parsed_response: {
          overall_score: 76,
          semantic_score: 75,
          llm_score: 78,
          communication_score: 72,
          ai_feedback: { summary: 'Reviewed live transcript was scored.' },
          per_question_scores: [],
        },
        token_usage: 500,
      })),
    };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-live-1',
      userId,
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    turns.find.mockResolvedValue([]);
    turns.save.mockImplementation(async (value) => ({
      ...value,
      id: `live-turn-${(value as InterviewTurnEntity).turnOrder}`,
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
      askedAt: new Date('2026-06-12T00:00:01.000Z'),
    }));
    sessions.save.mockImplementation(async (value) => value);

    const response = await service.end(userId, {
      sessionId: 'session-live-1',
      liveTurns: [
        {
          turnOrder: 1,
          interviewerQuestion: 'Bạn đã thiết kế API đó như thế nào?',
          userAnswerText: 'Em tách controller, service và repository.',
          userAnswerTranscript: 'Em tách controller, service và repository.',
          durationSeconds: 55,
        },
        {
          turnOrder: 2,
          interviewerQuestion: 'Bạn xử lý transaction ra sao?',
          userAnswerText: 'Em dùng transaction boundary ở service.',
          userAnswerTranscript: 'Em dùng transaction boundary ở service.',
          durationSeconds: 47,
        },
      ],
    });

    expect(turns.save).toHaveBeenCalledTimes(2);
    expect(turns.save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'session-live-1',
        turnOrder: 1,
        modality: 'AUDIO',
        interviewerQuestion: 'Bạn đã thiết kế API đó như thế nào?',
        userAnswerText: 'Em tách controller, service và repository.',
        userAnswerTranscript: 'Em tách controller, service và repository.',
        durationSeconds: 55,
      }),
    );
    expect(interviewAi.end).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        all_questions_answers: [
          {
            order: 1,
            question: 'Bạn đã thiết kế API đó như thế nào?',
            answer: 'Em tách controller, service và repository.',
          },
          {
            order: 2,
            question: 'Bạn xử lý transaction ra sao?',
            answer: 'Em dùng transaction boundary ở service.',
          },
        ],
      }),
    );
    expect(response.status).toBe('COMPLETED');
    expect(response.turns).toHaveLength(2);
  });

  it('cancels reviewed live realtime sessions when all reviewed answers are unsafe', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:04:00.000Z'));
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { end: jest.fn() };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-live-1',
      userId,
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    turns.find.mockResolvedValue([
      {
        id: 'stale-turn-1',
        sessionId: 'session-live-1',
        turnOrder: 1,
        phase: null,
        modality: 'AUDIO',
        interviewerQuestion: 'Stale backend question',
        userAnswerText: 'Stale answer must not be scored.',
        createdAt: new Date('2026-06-12T00:00:01.000Z'),
        askedAt: new Date('2026-06-12T00:00:01.000Z'),
      },
    ]);
    sessions.save.mockImplementation(async (value) => value);

    const response = await service.end(userId, {
      sessionId: 'session-live-1',
      liveTurns: [
        {
          turnOrder: 1,
          interviewerQuestion: 'Bạn phụ trách phần backend nào?',
          userAnswerText:
            '第一张原有很不流动来的求接下午。 Cuộc phỏng vấn bằng tiếng Việt. Giữ nguyên dấu tiếng Việt.',
          userAnswerTranscript:
            '第一张原有很不流动来的求接下午。 Cuộc phỏng vấn bằng tiếng Việt. Giữ nguyên dấu tiếng Việt.',
          durationSeconds: 58,
        },
      ],
    });

    expect(turns.save).not.toHaveBeenCalled();
    expect(interviewAi.end).not.toHaveBeenCalled();
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CANCELLED',
        durationSeconds: 240,
      }),
    );
    expect(response.status).toBe('CANCELLED');
  });

  it('ends a session and stores final scoring fields', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const interviewAi = { end: jest.fn() };
    const cvMatches = {
      getGapReport: jest.fn(async () => ({
        gap_items: [
          {
            requirement_id: 'jd:hard_skill:react',
            source: 'jd',
            type: 'hard_skill',
            canonical_name: 'react',
            display_name: 'React',
            importance: 'REQUIRED',
            cv_status: 'missing',
            fixability: 'learn',
            severity: 0.8,
            recommended_next_action: '',
          },
        ],
      })),
    };
    const coaching = {
      summary: 'Strong technical base; add more evidence.',
      strengths: ['technical_depth: outstanding'],
      priorities: [{ track: 'learn', title: 'Deepen React internals', why: 'Drill re-render' }],
    };
    const coachingService = { coach: jest.fn(async () => coaching) };
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      interviewAi as never,
      { assertCanUse: jest.fn(), recordUsage: jest.fn() } as never,
      { createClientSecret: jest.fn() } as never,
      undefined,
      cvMatches as never,
      {} as never,
      { judge: jest.fn() } as never,
      coachingService as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-1',
      userId,
      cvMatchId: 'match-1',
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      contextSnapshot: {
        interviewDifficulty: { level: 'mid', source: 'target role', note: 'test' },
      },
    });
    turns.find.mockResolvedValue([
      {
        id: 'turn-1',
        sessionId: 'session-1',
        turnOrder: 1,
        phase: 'SKILL_PROBE',
        topicPhase: 'SKILL_PROBE',
        depthSignal: 'deep',
        skillCanonical: 'react',
        currentThread: 'React Query',
        perQuestionScore: '82.00',
        signals: {
          jd_term_hits: { hit: ['React'], missed: [], coverage: 1 },
          filler: { count: 0, terms: [] },
          flags: { rambling_risk: false },
        },
        insight: {
          talking_point: 'project',
          relevance: 88,
          clarity: 'clear',
          off_topic: false,
          confidence_tone: 'calibrated',
          evidence_quality: 'strong',
          note: 'Specific example.',
          has_specific_example: true,
          star_present: { situation: true, task: true, action: true, result: true },
        },
        modality: 'AUDIO',
        interviewerQuestion: 'Bạn hãy giới thiệu dự án React gần nhất.',
        userAnswerText: 'Em dùng React Query và giảm stale cache.',
        createdAt: new Date('2026-06-12T00:00:01.000Z'),
        askedAt: new Date('2026-06-12T00:00:01.000Z'),
      },
    ]);
    sessions.save.mockImplementation(async (value) => value);

    const response = await service.end(userId, { sessionId: 'session-1' });

    expect(interviewAi.end).not.toHaveBeenCalled();
    expect(coachingService.coach).toHaveBeenCalledWith(
      expect.objectContaining({
        score: expect.objectContaining({
          overall: 82,
          dimensions: expect.arrayContaining([
            expect.objectContaining({ dimension: 'technical_depth', score: 82 }),
          ]),
        }),
        gaps: [],
        plan: expect.objectContaining({
          match_id: 'match-1',
          session_id: 'session-1',
          learn_items: [expect.objectContaining({ display_name: 'React', track: 'learn' })],
          cv_fix_items: [],
          interview_practice_items: [],
        }),
      }),
      userId,
    );
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'COMPLETED',
        overallScore: '82.00',
        semanticScore: '82.00',
        llmScore: '82.00',
        communicationScore: null,
        finalScore: expect.objectContaining({ overall: 82 }),
        gapItems: [],
        devPlan: expect.objectContaining({ session_id: 'session-1' }),
        coaching,
        // compat panels: deterministic rubric outputs mapped into the legacy FE shape
        aiFeedback: {
          summary: coaching.summary,
          strengths: coaching.strengths,
          priorities: coaching.priorities,
          technical_delivery: { technical_depth: 82 },
          communication_flow: {},
          recommendations: ['Deepen React internals'],
          suggested_modules: ['React'],
        },
      }),
    );
    expect(response.status).toBe('COMPLETED');
    expect(response.turns).toHaveLength(1);
    expect(response.finalScore).toMatchObject({ overall: 82 });
    expect(response.coaching).toEqual(coaching);
  });

  describe('stale session sweep on start', () => {
    const answeredStaleTurn = (turnOrder: number) => ({
      id: `stale-turn-${turnOrder}`,
      sessionId: 'stale-1',
      turnOrder,
      phase: 'SKILL_PROBE',
      topicPhase: 'SKILL_PROBE',
      depthSignal: 'deep',
      skillCanonical: 'rest_api',
      currentThread: 'REST API ownership',
      perQuestionScore: '80.00',
      signals: {
        jd_term_hits: { hit: ['REST'], missed: [], coverage: 1 },
        filler: { count: 0, terms: [] },
        flags: { rambling_risk: false },
      },
      insight: {
        talking_point: 'project',
        relevance: 80,
        clarity: 'clear',
        off_topic: false,
        confidence_tone: 'calibrated',
        evidence_quality: 'strong',
        note: 'Specific example.',
        has_specific_example: true,
        star_present: { situation: true, task: true, action: true, result: true },
      },
      modality: 'TEXT',
      interviewerQuestion: `Stale question ${turnOrder}`,
      userAnswerText: `Stale answer ${turnOrder} with concrete API details.`,
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
      askedAt: new Date('2026-06-12T00:00:01.000Z'),
    });

    const staleSession = (id: string) => ({
      id,
      userId,
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'HYBRID',
      interviewType: 'TECHNICAL',
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      expiresAt: new Date('2026-06-12T00:10:00.000Z'),
      maxDurationSeconds: 600,
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      contextSnapshot: {
        interviewDifficulty: { level: 'mid', source: 'target role', note: 'test' },
      },
    });

    const startDto = {
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    } as const;

    it('sweeps and scores a stale expired session with answers before charging a new one', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-12T01:00:00.000Z'));
      const sessions = repo<InterviewSessionEntity>();
      const turns = repo<InterviewTurnEntity>();
      const entitlements = {
        assertCanUse: jest.fn(async () => undefined),
        recordUsage: jest.fn(async () => undefined),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      };
      const coaching = { summary: 'Recovered abandoned session.', strengths: [], priorities: [] };
      const coachingService = { coach: jest.fn(async () => coaching) };
      sessions.find.mockResolvedValue([staleSession('stale-1')]);
      sessions.findOne.mockResolvedValue(staleSession('stale-1'));
      turns.find.mockResolvedValue([answeredStaleTurn(1), answeredStaleTurn(2)]);

      const service = new InterviewsService(
        sessions as never,
        turns as never,
        repo<CvEntity>() as never,
        repo<CvMatchEntity>() as never,
        repo<JobDescriptionEntity>() as never,
        { start: jest.fn(), end: jest.fn() } as never,
        entitlements as never,
        { createClientSecret: jest.fn() } as never,
        undefined,
        undefined,
        {} as never,
        { judge: jest.fn() } as never,
        coachingService as never,
      );

      const response = await service.start(userId, startDto);

      expect(sessions.find).toHaveBeenCalledWith({
        where: {
          userId,
          status: 'IN_PROGRESS',
          expiresAt: LessThan(new Date('2026-06-12T01:00:00.000Z')),
        },
      });
      expect(coachingService.coach).toHaveBeenCalledTimes(1);
      expect(sessions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stale-1',
          status: 'COMPLETED',
          endedAt: new Date('2026-06-12T00:10:00.000Z'),
          gapItems: expect.any(Array),
          finalScore: expect.objectContaining({ overall: expect.any(Number) }),
          coaching,
        }),
      );
      expect(response.id).toBe('generated-id');
      expect(response.status).toBe('IN_PROGRESS');
      expect(entitlements.recordUsage).toHaveBeenCalledTimes(1);
      expect(entitlements.recordUsage).toHaveBeenCalledWith(
        userId,
        BillingFeatureKey.INTERVIEW_SESSION,
        { sourceType: 'interview_session', sourceId: 'generated-id' },
      );
    });

    it('cancels a stale expired session with no answers before starting a new one', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-12T01:00:00.000Z'));
      const sessions = repo<InterviewSessionEntity>();
      const turns = repo<InterviewTurnEntity>();
      const interviewAi = { start: jest.fn(), end: jest.fn() };
      sessions.find.mockResolvedValue([staleSession('stale-0')]);
      sessions.findOne.mockResolvedValue(staleSession('stale-0'));
      turns.find.mockResolvedValue([
        {
          id: 'stale-turn-1',
          sessionId: 'stale-0',
          turnOrder: 1,
          phase: 'SCREENING',
          modality: 'TEXT',
          interviewerQuestion: 'Introduce yourself.',
          userAnswerText: null,
          createdAt: new Date('2026-06-12T00:00:01.000Z'),
          askedAt: new Date('2026-06-12T00:00:01.000Z'),
        },
      ]);

      const service = new InterviewsService(
        sessions as never,
        turns as never,
        repo<CvEntity>() as never,
        repo<CvMatchEntity>() as never,
        repo<JobDescriptionEntity>() as never,
        interviewAi as never,
        {
          assertCanUse: jest.fn(async () => undefined),
          recordUsage: jest.fn(async () => undefined),
          getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
        } as never,
        { createClientSecret: jest.fn() } as never,
      );

      const response = await service.start(userId, startDto);

      expect(interviewAi.end).not.toHaveBeenCalled();
      expect(sessions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stale-0',
          status: 'CANCELLED',
          endedAt: new Date('2026-06-12T00:10:00.000Z'),
          durationSeconds: 600,
        }),
      );
      expect(response.status).toBe('IN_PROGRESS');
    });

    it('leaves fresh in-progress sessions untouched when starting a new one', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-12T01:00:00.000Z'));
      const sessions = repo<InterviewSessionEntity>();
      const turns = repo<InterviewTurnEntity>();
      sessions.find.mockResolvedValue([]);

      const service = new InterviewsService(
        sessions as never,
        turns as never,
        repo<CvEntity>() as never,
        repo<CvMatchEntity>() as never,
        repo<JobDescriptionEntity>() as never,
        { start: jest.fn() } as never,
        {
          assertCanUse: jest.fn(async () => undefined),
          recordUsage: jest.fn(async () => undefined),
          getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
        } as never,
        { createClientSecret: jest.fn() } as never,
      );

      const response = await service.start(userId, startDto);

      expect(sessions.find).toHaveBeenCalledWith({
        where: {
          userId,
          status: 'IN_PROGRESS',
          expiresAt: LessThan(new Date('2026-06-12T01:00:00.000Z')),
        },
      });
      expect(sessions.findOne).not.toHaveBeenCalled();
      expect(response.status).toBe('IN_PROGRESS');
    });

    it('still starts a new session when the stale sweep fails', async () => {
      const sessions = repo<InterviewSessionEntity>();
      const turns = repo<InterviewTurnEntity>();
      const entitlements = {
        assertCanUse: jest.fn(async () => undefined),
        recordUsage: jest.fn(async () => undefined),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      };
      sessions.find.mockRejectedValue(new Error('db unavailable'));

      const service = new InterviewsService(
        sessions as never,
        turns as never,
        repo<CvEntity>() as never,
        repo<CvMatchEntity>() as never,
        repo<JobDescriptionEntity>() as never,
        { start: jest.fn() } as never,
        entitlements as never,
        { createClientSecret: jest.fn() } as never,
      );

      const response = await service.start(userId, startDto);

      expect(response.status).toBe('IN_PROGRESS');
      expect(entitlements.recordUsage).toHaveBeenCalledWith(
        userId,
        BillingFeatureKey.INTERVIEW_SESSION,
        expect.objectContaining({ sourceType: 'interview_session' }),
      );
    });
  });
});
