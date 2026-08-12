import { NotFoundException } from '@nestjs/common';
import { IsNull, LessThan, Not } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { InterviewQuestionBankItemEntity } from '../../database/entities/interview-question-bank-item.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { answerTimeBudgetSeconds, InterviewsService } from './interviews.service';

function repo<T extends { id?: string }>() {
  return {
    create: jest.fn((value: Partial<T>) => value as T),
    save: jest.fn(async (value: T) => ({ ...value, id: value.id ?? 'generated-id' })),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
    update: jest.fn(async () => ({ affected: 1 })),
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
        'Live Realtime mode: the backend owns the interview agenda, topic, difficulty, assistance, and scoring.',
        vars.context_block,
      ]
        .filter(Boolean)
        .join('\n\n'),
    ),
  };
  Object.assign(service, { prompts });
  return prompts;
}

function usageReservation() {
  return {
    eventId: 'usage-event-1',
    confirm: jest.fn(async () => undefined),
    refund: jest.fn(async () => undefined),
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
      'interview_realtime_v2',
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

  it('filters scored interview history before pagination', async () => {
    const sessions = repo<InterviewSessionEntity>();
    sessions.findAndCount.mockResolvedValue([[], 12]);
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

    const response = await service.list(userId, {
      page: 2,
      limit: 5,
      scoredOnly: true,
    } as never);

    expect(sessions.findAndCount).toHaveBeenCalledWith({
      where: {
        userId,
        status: 'COMPLETED',
        overallScore: Not(IsNull()),
      },
      order: { startedAt: 'DESC' },
      skip: 5,
      take: 5,
    });
    expect(response).toEqual({ items: [], total: 12, page: 2, limit: 5 });
  });

  it('starts a CV/JD-backed voice interview session and stores the first turn', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const cvs = repo<CvEntity>();
    const matches = repo<CvMatchEntity>();
    const jds = repo<JobDescriptionEntity>();
    const interviewAi = { start: jest.fn() };
    const reservation = usageReservation();
    const entitlements = {
      reserveUsage: jest.fn(async () => reservation),
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
      parsedJson: { contact: { name: 'Nguyen An' } },
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
      rawText: 'Company: FPT Software\nReact, TypeScript, testing, teamwork.',
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
      cvMatches as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => (key === 'llm.openai.realtimeVoice' ? 'cedar' : undefined)),
      } as never,
    );
    attachRealtimePrompts(service);

    const response = await service.start(userId, {
      cvId,
      cvMatchId: matchId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'VOICE',
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
    expect(entitlements.reserveUsage).toHaveBeenCalledWith(
      userId,
      BillingFeatureKey.INTERVIEW_SESSION,
    );
    expect(interviewAi.start).not.toHaveBeenCalled();
    expect(cvMatches.getInterviewFocusAreas).toHaveBeenCalledWith(userId, matchId, 'vi');
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agenda: expect.objectContaining({ turn_budget: 12 }),
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
    expect(reservation.confirm).toHaveBeenCalledWith({
      sourceType: 'interview_session',
      sourceId: 'session-1',
    });
    expect(reservation.refund).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      id: 'session-1',
      cvId,
      cvMatchId: matchId,
      jobDescriptionId: jdId,
      targetRole: 'frontend_developer',
      mode: 'VOICE',
      status: 'IN_PROGRESS',
      maxDurationSeconds: 600,
      firstQuestion:
        'To start, what have you been working on recently, and what drew you to this role?',
      phase: 'SCREENING',
      realtime: { enabled: true, clientSecret: 'eph_secret' },
    });
    expect(response.expiresAt).toBeTruthy();
    expect(response.firstMessage).toContain('Nguyen An');
    expect(response.firstMessage).toContain('FPT Software');
    expect(realtime.createClientSecret).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ id: 'session-1' }),
      expect.stringContaining('Candidate CV excerpt'),
    );
    expect((realtime.createClientSecret as jest.Mock).mock.calls[0][2]).toContain(
      'Employer explicitly identified by the JD: FPT Software',
    );
  });

  it('refunds the reserved usage when session persistence fails before a session exists', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const reservation = usageReservation();
    sessions.save.mockRejectedValue(new Error('session insert failed'));
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      {
        reserveUsage: jest.fn(async () => reservation),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      } as never,
      { createClientSecret: jest.fn() } as never,
    );

    await expect(
      service.start(userId, {
        targetRole: 'backend_developer',
        language: 'en',
        mode: 'TEXT',
        interviewType: 'TECHNICAL',
      }),
    ).rejects.toThrow('session insert failed');

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('does not refund usage when confirmation fails after the session and first turn exist', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const reservation = usageReservation();
    reservation.confirm.mockRejectedValue(new Error('usage confirmation failed'));
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      { start: jest.fn() } as never,
      {
        reserveUsage: jest.fn(async () => reservation),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      } as never,
      { createClientSecret: jest.fn() } as never,
    );

    await expect(
      service.start(userId, {
        targetRole: 'backend_developer',
        language: 'en',
        mode: 'TEXT',
        interviewType: 'TECHNICAL',
      }),
    ).rejects.toThrow('usage confirmation failed');

    expect(reservation.refund).not.toHaveBeenCalled();
    expect(sessions.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'FAILED' }));
  });

  it('uses a DB question bank item for the first realtime interview turn', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const questionBank = repo<InterviewQuestionBankItemEntity>();
    const entitlements = {
      reserveUsage: jest.fn(async () => usageReservation()),
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
      reserveUsage: jest.fn(async () => usageReservation()),
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
    expect(response.totalQuestionsPlanned).toBe(12);
  });

  it('marks role-only sessions explicitly and avoids CV/JD-specific question wording', async () => {
    const sessions = repo<InterviewSessionEntity>();
    const turns = repo<InterviewTurnEntity>();
    const questionBank = repo<InterviewQuestionBankItemEntity>();
    const entitlements = {
      reserveUsage: jest.fn(async () => usageReservation()),
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
      reserveUsage: jest.fn(async () => usageReservation()),
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
    const agenda = createdSession.agenda as {
      topics: Array<{ seed_question: string; phase: string }>;
    };
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
      reserveUsage: jest.fn(async () => usageReservation()),
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
        reserveUsage: jest.fn(async () => usageReservation()),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      } as never,
      realtime as never,
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
      reserveUsage: jest.fn(async () => usageReservation()),
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
      {
        get: jest.fn((key: string) => (key === 'llm.openai.realtimeVoice' ? 'cedar' : undefined)),
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
          'Xin chào bạn, tôi là AI interviewer của SkillBridge cho vị trí Backend Developer. Mình sẽ trao đổi về kinh nghiệm và một vài tình huống thực tế; chúng ta bắt đầu nhé.',
        interviewerQuestion:
          'To start, what have you been working on recently, and what drew you to this role?',
      }),
    );
    expect(realtime.createClientSecret).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ id: 'session-live-1', mode: 'VOICE' }),
      expect.stringContaining('the backend owns the interview agenda'),
    );
    const instructions = (realtime.createClientSecret as jest.Mock).mock.calls[0][2] as string;
    expect(instructions).toContain('topic, difficulty, assistance, and scoring');
    expect(instructions).not.toContain('Guided Voice mode');
    expect(instructions).toContain('Candidate seniority level: junior');
    expect(instructions).toContain(
      'No explicit seniority signal was found; use a junior-friendly baseline',
    );
    expect(response).toMatchObject({
      id: 'session-live-1',
      mode: 'VOICE',
      status: 'IN_PROGRESS',
      totalQuestionsPlanned: 12,
      firstMessage:
        'Xin chào bạn, tôi là AI interviewer của SkillBridge cho vị trí Backend Developer. Mình sẽ trao đổi về kinh nghiệm và một vài tình huống thực tế; chúng ta bắt đầu nhé.',
      firstQuestion:
        'To start, what have you been working on recently, and what drew you to this role?',
      phase: 'SCREENING',
      realtime: { enabled: true, clientSecret: 'live_secret' },
    });
  });

  it('prioritizes unique skill-specific questions over role-wide scenarios', () => {
    const service = new InterviewsService(
      repo<InterviewSessionEntity>() as never,
      repo<InterviewTurnEntity>() as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const common = {
      language: 'en' as const,
      targetRole: 'frontend_developer',
      interviewType: 'TECHNICAL' as const,
      phase: 'SKILL_PROBE' as const,
      seniority: null,
      difficulty: 2,
      expectedSignals: ['technical_decision'],
      rubricDimensions: ['technical_depth'],
      sourceKind: 'authored_from_taxonomy',
      sourceUrl: null,
      sourceBasis: 'SkillBridge authored.',
      license: 'SkillBridge authored',
      attribution: null,
      reviewStatus: 'approved',
      active: true,
    };
    const candidates = [
      {
        ...common,
        id: 'role-wide-ssr',
        questionKey: 'frontend-role-wide-ssr',
        skillCanonical: null,
        focusType: null,
        questionText: 'Would you choose SSR or CSR for a product page?',
        priority: 100,
      },
      {
        ...common,
        id: 'react-state-1',
        questionKey: 'frontend-react-state-1',
        skillCanonical: 'react',
        focusType: 'depth_probe' as const,
        questionText: 'How do you manage auth state and sessions in React?',
        priority: 20,
      },
      {
        ...common,
        id: 'react-state-2',
        questionKey: 'frontend-react-state-2',
        skillCanonical: 'react',
        focusType: 'depth_probe' as const,
        questionText: 'How do you handle refresh tokens and API failures in React?',
        priority: 10,
      },
    ];
    const agenda = {
      topics: [
        {
          id: 'react-ownership',
          phase: 'SKILL_PROBE',
          skill_canonical: 'react',
          focus_type: 'strength_showcase',
          seed_question: 'Fallback one',
        },
        {
          id: 'react-depth',
          phase: 'SKILL_PROBE',
          skill_canonical: 'react',
          focus_type: 'strength_showcase',
          seed_question: 'Fallback two',
        },
      ],
      uncovered: [],
    };

    const result = (
      service as unknown as {
        applyQuestionBankToAgenda: (
          value: typeof agenda,
          items: typeof candidates,
          criteria: {
            language: 'vi' | 'en';
            targetRole: string;
            interviewType: 'HR' | 'TECHNICAL' | 'MIXED';
            seniority: string;
          },
          contextMode: 'ROLE_ONLY' | 'CV_ONLY' | 'CV_JD_MATCH',
        ) => {
          topics: Array<(typeof agenda.topics)[number] & { question_bank_key?: string }>;
          uncovered: unknown[];
        };
      }
    ).applyQuestionBankToAgenda(
      agenda,
      candidates,
      {
        language: 'en',
        targetRole: 'frontend_developer',
        interviewType: 'TECHNICAL',
        seniority: 'junior',
      },
      'ROLE_ONLY',
    );

    expect(result.topics.map((topic) => topic.seed_question)).toEqual([
      'How do you manage auth state and sessions in React?',
      'How do you handle refresh tokens and API failures in React?',
    ]);
    expect(new Set(result.topics.map((topic) => topic.question_bank_key)).size).toBe(2);
    expect(result.topics.map((topic) => topic.seed_question).join(' ')).not.toMatch(/SSR|CSR/);
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
        reserveUsage: jest.fn(async () => usageReservation()),
        getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
      } as never,
      realtime as never,
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
    expect(instructions).toContain('the backend owns the interview agenda');
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
        reserveUsage: jest.fn(async () => usageReservation()),
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
      { reserveUsage: jest.fn(async () => usageReservation()) } as never,
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
      mode: 'VOICE',
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
        reserveUsage: jest.fn(async () => usageReservation()),
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
      { reserveUsage: jest.fn(async () => usageReservation()) } as never,
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
        mode: 'VOICE',
        interviewType: 'TECHNICAL',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an already completed session without scoring or saving again', async () => {
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
      { reserveUsage: jest.fn(async () => usageReservation()) } as never,
      { createClientSecret: jest.fn() } as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-complete',
      userId,
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
      status: 'COMPLETED',
      finalScore: { overall: 82 },
      overallScore: '82',
      startedAt: new Date('2026-06-12T00:00:00.000Z'),
      endedAt: new Date('2026-06-12T00:10:00.000Z'),
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    turns.find.mockResolvedValue([
      {
        id: 'turn-1',
        sessionId: 'session-complete',
        turnOrder: 1,
        phase: 'SKILL_PROBE',
        modality: 'AUDIO',
        interviewerQuestion: 'How do you design idempotent APIs?',
        userAnswerText: 'Use a stable request key and persist the response.',
        answeredAt: new Date('2026-06-12T00:02:00.000Z'),
        createdAt: new Date('2026-06-12T00:01:00.000Z'),
        askedAt: new Date('2026-06-12T00:01:00.000Z'),
      },
    ]);

    const response = await service.end(userId, { sessionId: 'session-complete' });

    expect(response.status).toBe('COMPLETED');
    expect(response.finalScore).toEqual({ overall: 82 });
    expect(interviewAi.end).not.toHaveBeenCalled();
    expect(sessions.save).not.toHaveBeenCalled();
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
      { reserveUsage: jest.fn(async () => usageReservation()) } as never,
      { createClientSecret: jest.fn() } as never,
    );
    sessions.findOne.mockResolvedValue({
      id: 'session-1',
      userId,
      targetRole: 'frontend_developer',
      language: 'vi',
      mode: 'VOICE',
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
      { reserveUsage: jest.fn(async () => usageReservation()) } as never,
      { createClientSecret: jest.fn() } as never,
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
      mode: 'VOICE',
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
    // Wave I-SCORE: per-dimension explanations ride inside finalScore, additively.
    expect(response.finalScore).toMatchObject({
      score_explanations: expect.arrayContaining([
        expect.objectContaining({
          dimension: 'technical_depth',
          score: 82,
          band: 'outstanding',
          rubric_anchor: expect.stringContaining('outstanding'),
          evidence_quote: expect.stringContaining('React Query'),
          linked_question_id: 'turn-1',
          uncertainty: 'medium',
          improvement_hint: null,
        }),
      ]),
    });
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
      mode: 'VOICE',
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
      const reservation = usageReservation();
      const entitlements = {
        reserveUsage: jest.fn(async () => reservation),
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
        {} as never,
        { judge: jest.fn() } as never,
        coachingService as never,
      );

      const response = await service.start(userId, startDto);

      expect(sessions.find).toHaveBeenCalledWith({
        where: [
          {
            userId,
            status: 'IN_PROGRESS',
            expiresAt: LessThan(new Date('2026-06-12T01:00:00.000Z')),
          },
          {
            userId,
            status: 'COMPLETED',
            overallScore: IsNull(),
            expiresAt: LessThan(new Date('2026-06-12T01:00:00.000Z')),
          },
        ],
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
      expect(entitlements.reserveUsage).toHaveBeenCalledTimes(1);
      expect(reservation.confirm).toHaveBeenCalledWith({
        sourceType: 'interview_session',
        sourceId: 'generated-id',
      });
    });

    // Without this, a session whose finalization throws sits IN_PROGRESS forever, indistinguishable
    // from one the user walked away from — so `FAILED` stays legal in the enum and the CHECK
    // constraint but never written, and nobody can ask what share of interviews break.
    it('records FAILED when finalizing a stale session throws', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-12T01:00:00.000Z'));
      const sessions = repo<InterviewSessionEntity>();
      const turns = repo<InterviewTurnEntity>();
      sessions.find.mockResolvedValue([staleSession('stale-boom')]);
      sessions.findOne.mockResolvedValue(staleSession('stale-boom'));
      // make the finalization path blow up the way a real end() failure would
      turns.find.mockRejectedValue(new Error('turn read failed'));

      const service = new InterviewsService(
        sessions as never,
        turns as never,
        repo<CvEntity>() as never,
        repo<CvMatchEntity>() as never,
        repo<JobDescriptionEntity>() as never,
        { start: jest.fn(), end: jest.fn() } as never,
        {
          reserveUsage: jest.fn(async () => usageReservation()),
          getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
        } as never,
        { createClientSecret: jest.fn() } as never,
        undefined,
        {} as never,
        { judge: jest.fn() } as never,
        { coach: jest.fn() } as never,
      );

      // the sweep must never block the new session, however badly it went
      const response = await service.start(userId, startDto);
      expect(response.id).toBe('generated-id');

      expect(sessions.update).toHaveBeenCalledWith(
        { id: 'stale-boom', overallScore: IsNull() },
        { status: 'FAILED' },
      );
    });

    // The cross cell, and the one a status-pinned guard gets wrong: a stranded COMPLETED row whose
    // finalization ALSO throws. It must reach a terminal state, because it still matches the sweep
    // predicate — leave it un-terminated and every later start re-runs end() on it, paying for a
    // coaching call each time, forever.
    it('terminates a stranded COMPLETED session whose finalization also throws', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-12T01:00:00.000Z'));
      const sessions = repo<InterviewSessionEntity>();
      const turns = repo<InterviewTurnEntity>();
      const stranded = {
        ...staleSession('stale-stranded-boom'),
        status: 'COMPLETED' as const,
        overallScore: null,
      };
      sessions.find.mockResolvedValue([stranded]);
      sessions.findOne.mockResolvedValue(stranded);
      turns.find.mockRejectedValue(new Error('turn read failed'));

      const service = new InterviewsService(
        sessions as never,
        turns as never,
        repo<CvEntity>() as never,
        repo<CvMatchEntity>() as never,
        repo<JobDescriptionEntity>() as never,
        { start: jest.fn(), end: jest.fn() } as never,
        {
          reserveUsage: jest.fn(async () => usageReservation()),
          getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
        } as never,
        { createClientSecret: jest.fn() } as never,
        undefined,
        {} as never,
        { judge: jest.fn() } as never,
        { coach: jest.fn() } as never,
      );

      await service.start(userId, startDto);

      // guarded on "still has no score", not on status — the condition that put it here.
      expect(sessions.update).toHaveBeenCalledWith(
        { id: 'stale-stranded-boom', overallScore: IsNull() },
        { status: 'FAILED' },
      );
    });

    // The stranded-row case: `answer` (engine finished), `assertNotExpired` (time limit) and the
    // legacy end all mark a session COMPLETED, but ONLY end() writes the score. When the client
    // never calls /end, the row is COMPLETED with a null score — hidden from the user's own
    // history by list()'s `overallScore: Not(IsNull())` filter, and, before this, never reachable
    // by the sweep either, because it only looked at IN_PROGRESS. Nothing could heal it.
    it('scores a COMPLETED session that was stranded without a score', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-12T01:00:00.000Z'));
      const sessions = repo<InterviewSessionEntity>();
      const turns = repo<InterviewTurnEntity>();
      const stranded = {
        ...staleSession('stale-stranded'),
        status: 'COMPLETED' as const,
        overallScore: null,
      };
      const coaching = { summary: 'Recovered stranded session.', strengths: [], priorities: [] };
      const coachingService = { coach: jest.fn(async () => coaching) };
      sessions.find.mockResolvedValue([stranded]);
      sessions.findOne.mockResolvedValue(stranded);
      turns.find.mockResolvedValue([answeredStaleTurn(1), answeredStaleTurn(2)]);

      const service = new InterviewsService(
        sessions as never,
        turns as never,
        repo<CvEntity>() as never,
        repo<CvMatchEntity>() as never,
        repo<JobDescriptionEntity>() as never,
        { start: jest.fn(), end: jest.fn() } as never,
        {
          reserveUsage: jest.fn(async () => usageReservation()),
          getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
        } as never,
        { createClientSecret: jest.fn() } as never,
        undefined,
        {} as never,
        { judge: jest.fn() } as never,
        coachingService as never,
      );

      await service.start(userId, startDto);

      // it went through the same partial-scoring path as /end — the report now exists.
      expect(sessions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stale-stranded',
          status: 'COMPLETED',
          finalScore: expect.objectContaining({ overall: expect.any(Number) }),
          coaching,
        }),
      );
      // and it is NOT relabelled a failure: it completed, it was just never scored.
      expect(sessions.update).not.toHaveBeenCalled();
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
          reserveUsage: jest.fn(async () => usageReservation()),
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
          reserveUsage: jest.fn(async () => usageReservation()),
          getCurrentEntitlements: jest.fn(async () => ({ planCode: 'PRO' })),
        } as never,
        { createClientSecret: jest.fn() } as never,
      );

      const response = await service.start(userId, startDto);

      expect(sessions.find).toHaveBeenCalledWith({
        where: [
          {
            userId,
            status: 'IN_PROGRESS',
            expiresAt: LessThan(new Date('2026-06-12T01:00:00.000Z')),
          },
          {
            userId,
            status: 'COMPLETED',
            overallScore: IsNull(),
            expiresAt: LessThan(new Date('2026-06-12T01:00:00.000Z')),
          },
        ],
      });
      expect(sessions.findOne).not.toHaveBeenCalled();
      expect(response.status).toBe('IN_PROGRESS');
    });

    it('still starts a new session when the stale sweep fails', async () => {
      const sessions = repo<InterviewSessionEntity>();
      const turns = repo<InterviewTurnEntity>();
      const reservation = usageReservation();
      const entitlements = {
        reserveUsage: jest.fn(async () => reservation),
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
      expect(reservation.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ sourceType: 'interview_session' }),
      );
    });
  });
});

describe('answerTimeBudgetSeconds', () => {
  it('gives a fresh question the full budget and a drill less', () => {
    expect(answerTimeBudgetSeconds('opening')).toBe(90);
    expect(answerTimeBudgetSeconds('transition')).toBe(90);
    expect(answerTimeBudgetSeconds('follow_up')).toBe(60);
    expect(answerTimeBudgetSeconds('closing')).toBe(60);
  });

  it('budgets nothing when no question is coming', () => {
    // a finished interview has no next question to time.
    expect(answerTimeBudgetSeconds(null)).toBeNull();
  });
});
