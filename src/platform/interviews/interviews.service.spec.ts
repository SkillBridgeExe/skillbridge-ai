import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
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
    const interviewAi = {
      start: jest.fn(async () => ({
        ai_request_id: 'ai-start-1',
        first_message: 'Chào bạn, mình là interviewer hôm nay.',
        first_question: 'Bạn hãy giới thiệu ngắn về dự án React gần nhất.',
        phase: 'INTRODUCTION',
        total_questions_planned: 7,
        token_usage: 120,
      })),
    };
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

    const service = new InterviewsService(
      sessions as never,
      turns as never,
      cvs as never,
      matches as never,
      jds as never,
      interviewAi as never,
      entitlements as never,
      realtime as never,
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
    expect(interviewAi.start).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        session_id: 'session-1',
        topic: 'frontend_developer',
        language: 'vi',
        interview_type: 'TECHNICAL',
        prompt_template_code: 'interview_technical_v1',
        cv_context: expect.stringContaining('Frontend Intern'),
      }),
    );
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        turnOrder: 1,
        interviewerQuestion: 'Bạn hãy giới thiệu ngắn về dự án React gần nhất.',
        aiRequestId: 'ai-start-1',
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
      firstQuestion: 'Bạn hãy giới thiệu ngắn về dự án React gần nhất.',
      realtime: { enabled: true, clientSecret: 'eph_secret' },
    });
    expect(response.expiresAt).toBeTruthy();
    expect(realtime.createClientSecret).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ id: 'session-1' }),
      expect.not.stringContaining('Candidate CV excerpt'),
    );
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
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      {
        answer: jest.fn(async () => ({
          ai_request_id: 'ai-answer-1',
          ai_message: 'Cảm ơn bạn, mình hỏi tiếp nhé.',
          next_question: 'Bạn xử lý stale server state trong React như thế nào?',
          phase: 'TECHNICAL_DEEP_DIVE',
          finished: false,
          per_question_score: 76,
          per_question_strengths: ['Có ví dụ thực tế'],
          per_question_improvements: ['Nêu rõ trade-off hơn'],
        })),
      } as never,
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
    const pendingTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      turnOrder: 1,
      phase: 'INTRODUCTION',
      modality: 'AUDIO',
      interviewerQuestion: 'Bạn hãy giới thiệu dự án React gần nhất.',
      userAnswerText: null,
      createdAt: new Date('2026-06-12T00:00:01.000Z'),
      askedAt: new Date('2026-06-12T00:00:01.000Z'),
    };
    turns.find.mockResolvedValue([]);
    turns.findOne
      .mockResolvedValueOnce(pendingTurn as InterviewTurnEntity)
      .mockResolvedValueOnce(pendingTurn as InterviewTurnEntity);
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

    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'turn-1',
        userAnswerText: 'Em dùng React Query để cache và invalidate theo mutation.',
        userAnswerTranscript: 'Em dùng React Query để cache...',
        perQuestionScore: '76.00',
      }),
    );
    expect(response.nextTurn).toMatchObject({
      sessionId: 'session-1',
      turnOrder: 2,
      interviewerQuestion: 'Bạn xử lý stale server state trong React như thế nào?',
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
      userAnswer: 'Current answer',
      modality: 'AUDIO',
    });

    expect(interviewAi.answer).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        question_history: [
          { order: 3, question: 'Question 3', answer: 'Answer 3' },
          { order: 4, question: 'Question 4', answer: 'Answer 4' },
          { order: 5, question: 'Question 5', answer: 'Answer 5' },
          { order: 6, question: 'Question 6', answer: 'Answer 6' },
          { order: 7, question: 'Question 7', answer: 'Answer 7' },
          { order: 8, question: 'Question 8', answer: 'Current answer' },
        ],
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
    const service = new InterviewsService(
      sessions as never,
      turns as never,
      repo<CvEntity>() as never,
      repo<CvMatchEntity>() as never,
      repo<JobDescriptionEntity>() as never,
      {
        end: jest.fn(async () => ({
          ai_request_id: 'ai-end-1',
          parsed_response: {
            overall_score: 82,
            semantic_score: 80,
            llm_score: 84,
            communication_score: 78,
            ai_feedback: {
              summary: 'Bạn trả lời có cấu trúc và sát JD.',
              technical_delivery: {
                concept_accuracy: 82,
                problem_solving: 80,
                system_thinking: 78,
                code_quality: 84,
              },
              communication_flow: {
                articulation: 80,
                listening_response: 78,
                filler_words: 75,
                structured_answers: 82,
              },
              body_language: null,
              recommendations: 'Luyện thêm testing.',
              suggested_modules: [],
            },
            per_question_scores: [],
          },
          token_usage: 500,
        })),
      } as never,
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
        interviewerQuestion: 'Bạn hãy giới thiệu dự án React gần nhất.',
        userAnswerText: 'Em dùng React Query.',
        createdAt: new Date('2026-06-12T00:00:01.000Z'),
        askedAt: new Date('2026-06-12T00:00:01.000Z'),
      },
    ]);
    sessions.save.mockImplementation(async (value) => value);

    const response = await service.end(userId, { sessionId: 'session-1' });

    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'COMPLETED',
        finalAiRequestId: 'ai-end-1',
        overallScore: '82.00',
        semanticScore: '80.00',
        llmScore: '84.00',
        communicationScore: '78.00',
        aiFeedback: expect.objectContaining({ summary: 'Bạn trả lời có cấu trúc và sát JD.' }),
      }),
    );
    expect(response.status).toBe('COMPLETED');
    expect(response.turns).toHaveLength(1);
  });
});
