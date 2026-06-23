import { BadRequestException, NotFoundException } from '@nestjs/common';
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

describe('InterviewsService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const cvId = '22222222-2222-4222-8222-222222222222';
  const matchId = '33333333-3333-4333-8333-333333333333';
  const jdId = '44444444-4444-4444-8444-444444444444';

  afterEach(() => {
    jest.useRealTimers();
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
    );

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

    const response = await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    });

    expect(questionBank.find).toHaveBeenCalled();
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewerQuestion: 'Hay gioi thieu du an backend gan nhat cua ban.',
        questionBankItemId: 'bank-screening-vi',
        questionBankKey: 'backend-common-screening-01',
      }),
    );
    expect(response.firstQuestion).toBe('Hay gioi thieu du an backend gan nhat cua ban.');
  });

  it('starts a live VOICE interview without backend-generated question turns', async () => {
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
    );

    const response = await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
    });

    expect(interviewAi.start).not.toHaveBeenCalled();
    expect(turns.save).not.toHaveBeenCalled();
    expect(realtime.createClientSecret).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ id: 'session-live-1', mode: 'VOICE' }),
      expect.not.stringContaining('official question directive'),
    );
    const instructions = (realtime.createClientSecret as jest.Mock).mock.calls[0][2] as string;
    expect(instructions).toContain('Open with 1-2 short sentences only');
    expect(instructions).toContain('Use the CV/JD context silently');
    expect(instructions).toContain('If the candidate asks for answers');
    expect(instructions).toContain('redirect back to the current interview question');
    expect(instructions).toContain('When the app sends a closing instruction');
    expect(instructions).toContain('Candidate seniority level: junior');
    expect(instructions).toContain(
      'No explicit seniority signal was found; use a junior-friendly baseline',
    );
    expect(response).toMatchObject({
      id: 'session-live-1',
      mode: 'VOICE',
      status: 'IN_PROGRESS',
      totalQuestionsPlanned: 7,
      firstMessage: '',
      firstQuestion: '',
      phase: null,
      realtime: { enabled: true, clientSecret: 'live_secret' },
    });
  });

  it('adds DB question bank anchors to live VOICE realtime instructions', async () => {
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

    await service.start(userId, {
      targetRole: 'backend_developer',
      language: 'vi',
      mode: 'VOICE',
      interviewType: 'TECHNICAL',
    });

    const instructions = (realtime.createClientSecret as jest.Mock).mock.calls[0][2] as string;
    expect(instructions).toContain('Curated question anchors');
    expect(instructions).toContain('Hay mo dau bang du an backend gan nhat cua ung vien.');
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
      expiresAt: new Date('2026-06-12T00:10:00.000Z'),
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

  it('creates question audio only from the current pending interview question', async () => {
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
      expiresAt: new Date('2026-06-12T00:10:00.000Z'),
      maxDurationSeconds: 600,
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    } as InterviewSessionEntity;
    const pendingTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      turnOrder: 1,
      interviewerQuestion: 'Bạn hãy giới thiệu dự án React gần nhất.',
      userAnswerText: null,
    } as InterviewTurnEntity;
    sessions.findOne.mockResolvedValue(session);
    turns.findOne.mockResolvedValue(pendingTurn);

    const response = await service.createQuestionAudio(userId, 'session-1');

    expect(questionAudio.createQuestionAudio).toHaveBeenCalledWith(
      userId,
      session,
      'Bạn hãy giới thiệu dự án React gần nhất.',
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
        gapsRevealed: ['Missing trade-off detail'],
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
        gap_items: [],
      })),
    };
    const coaching = {
      summary: 'Strong technical base; add more evidence.',
      strengths: ['technical_depth: outstanding'],
      priorities: [],
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
          match_id: '',
          session_id: 'session-1',
          learn_items: [],
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
        aiFeedback: expect.objectContaining({ summary: coaching.summary }),
      }),
    );
    expect(response.status).toBe('COMPLETED');
    expect(response.turns).toHaveLength(1);
    expect(response.finalScore).toMatchObject({ overall: 82 });
    expect(response.coaching).toEqual(coaching);
  });
});
