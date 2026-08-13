import { NotFoundException } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import { InterviewRealtimeDirectiveEntity } from '../../database/entities/interview-realtime-directive.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { SkillTextScannerService } from '../../common/services/skill-text-scanner.service';
import { InterviewRealtimeService } from './interview-realtime.service';
import { InterviewTurnPolicyService } from './interview-turn-policy.service';

type RepoMock<T extends ObjectLiteral> = Pick<Repository<T>, 'findOne' | 'create' | 'save'>;

describe('InterviewRealtimeService', () => {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    status: 'IN_PROGRESS',
    experienceMode: 'MOCK',
    agenda: {
      topics: [
        { id: 'api', what_to_probe: 'API trade-offs', seed_question: 'Design an API.' },
        {
          id: 'cache',
          what_to_probe: 'Cache trade-offs',
          seed_question: 'Design a cache.',
          phase: 'SKILL_PROBE',
          skill_canonical: 'redis',
          question_bank_key: 'backend-redis-01',
        },
      ],
    },
    interviewState: {
      realtime: {
        topicId: 'api',
        questionThreadId: '22222222-2222-4222-8222-222222222222',
        difficultyStep: 0,
        noAnswerCount: 0,
        probeCount: 0,
        assistanceLevel: 'NONE',
        scoreCap: null,
        topicHistory: ['api'],
        questionFingerprints: [],
      },
    },
  } as unknown as InterviewSessionEntity;
  const currentTurn = {
    id: '33333333-3333-4333-8333-333333333333',
    sessionId: session.id,
    turnOrder: 1,
    interviewerQuestion: 'Design an API.',
    currentThread: 'API trade-offs',
    questionThreadId: '22222222-2222-4222-8222-222222222222',
    answeredAt: null,
  } as InterviewTurnEntity;

  function createService(existingDirective: InterviewRealtimeDirectiveEntity | null = null) {
    const sessions = {
      findOne: jest.fn().mockResolvedValue(session),
      create: jest.fn(),
      save: jest.fn(async (value) => value),
    } as unknown as RepoMock<InterviewSessionEntity>;
    const turns = {
      findOne: jest.fn().mockResolvedValue(currentTurn),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    } as unknown as RepoMock<InterviewTurnEntity>;
    const directives = {
      findOne: jest.fn().mockResolvedValue(existingDirective),
      create: jest.fn((value) => ({ id: '44444444-4444-4444-8444-444444444444', ...value })),
      save: jest.fn(async (value) => value),
    } as unknown as RepoMock<InterviewRealtimeDirectiveEntity>;
    const service = new InterviewRealtimeService(
      sessions as Repository<InterviewSessionEntity>,
      turns as Repository<InterviewTurnEntity>,
      directives as Repository<InterviewRealtimeDirectiveEntity>,
      new InterviewTurnPolicyService(),
      {
        scan: jest.fn(() => []),
      } as unknown as SkillTextScannerService,
    );
    return { service, sessions, turns, directives };
  }

  it('returns the persisted directive for duplicate clientTurnId without saving twice', async () => {
    const persisted = {
      id: '44444444-4444-4444-8444-444444444444',
      sessionId: session.id,
      clientTurnId: 'client-1',
      action: 'ADVANCE_TOPIC',
      topicId: 'cache',
      questionThreadId: '55555555-5555-4555-8555-555555555555',
      difficultyStep: 0,
      assistanceLevel: 'NONE',
      scoreCap: null,
      threadScore: null,
      consumesAttempt: true,
      questionGoal: 'Cache trade-offs',
      finished: false,
    } as InterviewRealtimeDirectiveEntity;
    const { service, directives, turns } = createService(persisted);

    const result = await service.submitTurn('user-1', session.id, {
      clientTurnId: 'client-1',
      transcript: 'Use REST with idempotency keys.',
      modality: 'AUDIO',
      intent: 'ANSWER',
      answerSignal: 'COMPLETE',
    });

    expect(result.directiveId).toBe(persisted.id);
    expect(directives.save).not.toHaveBeenCalled();
    expect(turns.save).not.toHaveBeenCalled();
  });

  it('rejects unsafe CJK capture without consuming the pending question', async () => {
    const { service, turns, directives } = createService();

    const result = await service.submitTurn('user-1', session.id, {
      clientTurnId: 'client-cjk',
      transcript: '我們要覺得',
      modality: 'AUDIO',
      intent: 'ANSWER',

      answerSignal: 'OFF_TOPIC',
    });

    expect(result).toMatchObject({
      action: 'RETRY_CAPTURE',
      consumesAttempt: false,
      questionThreadId: currentTurn.questionThreadId,
    });
    expect(turns.save).not.toHaveBeenCalled();
    expect(directives.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RETRY_CAPTURE',
        consumesAttempt: false,
      }),
    );
  });

  it('returns a structured busy error while the previous directive is waiting for commit', async () => {
    const pending = {
      id: '66666666-6666-4666-8666-666666666666',
      sessionId: session.id,
      clientTurnId: 'client-pending',
      action: 'FOLLOW_UP',
      topicId: 'api',
      questionThreadId: currentTurn.questionThreadId,
      difficultyStep: 0,
      assistanceLevel: 'NONE',
      scoreCap: null,
      threadScore: null,
      consumesAttempt: true,
      questionGoal: 'Follow up on the API.',
      finished: false,
      committedAt: null,
    } as InterviewRealtimeDirectiveEntity;
    const { service, directives, turns } = createService();
    (directives.findOne as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(pending);

    await expect(
      service.submitTurn('user-1', session.id, {
        clientTurnId: 'client-next',
        transcript: 'A second answer arrived too early.',
        modality: 'AUDIO',
        intent: 'ANSWER',
        answerSignal: 'COMPLETE',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'INTERVIEW_TURN_BUSY' }),
    });
    expect(turns.findOne).not.toHaveBeenCalled();
  });

  it('preserves the first no-answer attempt and creates the easier question in the same thread', async () => {
    const directive = {
      id: '44444444-4444-4444-8444-444444444444',
      sessionId: session.id,
      turnId: currentTurn.id,
      action: 'LOWER_DIFFICULTY',
      consumesAttempt: true,
      topicId: 'api',
      questionThreadId: currentTurn.questionThreadId,
      difficultyStep: -1,
      assistanceLevel: 'EASIER',
      scoreCap: 75,
      threadScore: null,
      questionGoal: 'API trade-offs; ask one level easier',
      finished: false,
      committedAt: null,
    } as InterviewRealtimeDirectiveEntity;
    const answeredTurn = {
      ...currentTurn,
      userAnswerText: 'I do not know.',
      answeredAt: new Date('2026-08-10T10:00:00.000Z'),
    } as InterviewTurnEntity;
    const { service, turns } = createService(directive);
    const turnFindOne = turns.findOne as jest.Mock;
    turnFindOne.mockResolvedValueOnce(answeredTurn).mockResolvedValueOnce(null);

    await service.commitAssistantMessage('user-1', session.id, directive.id, {
      responseId: 'response-1',
      interviewerMessage: 'Let us simplify it.',
      interviewerQuestion: 'What is one benefit of an idempotency key?',
    });

    expect(answeredTurn.userAnswerText).toBe('I do not know.');
    expect(answeredTurn.answeredAt).not.toBeNull();
    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        turnOrder: 2,
        questionThreadId: currentTurn.questionThreadId,
        interviewerQuestion: 'What is one benefit of an idempotency key?',
        sourceDirectiveId: directive.id,
      }),
    );
  });

  it('creates the next turn with agenda skill and question-bank metadata instead of topic id', async () => {
    const directive = {
      id: '44444444-4444-4444-8444-444444444444',
      sessionId: session.id,
      turnId: currentTurn.id,
      action: 'ADVANCE_TOPIC',
      consumesAttempt: true,
      topicId: 'cache',
      questionThreadId: '55555555-5555-4555-8555-555555555555',
      difficultyStep: 0,
      assistanceLevel: 'NONE',
      scoreCap: null,
      threadScore: null,
      questionGoal: 'Design a cache.',
      finished: false,
      committedAt: null,
    } as InterviewRealtimeDirectiveEntity;
    const answeredTurn = {
      ...currentTurn,
      answeredAt: new Date('2026-08-10T10:00:00.000Z'),
    } as InterviewTurnEntity;
    const { service, turns } = createService(directive);
    const turnFindOne = turns.findOne as jest.Mock;
    turnFindOne.mockResolvedValueOnce(answeredTurn).mockResolvedValueOnce(null);

    await service.commitAssistantMessage('user-1', session.id, directive.id, {
      responseId: 'response-cache',
      interviewerQuestion: 'How would you design the cache?',
    });

    expect(turns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        topicPhase: 'SKILL_PROBE',
        skillCanonical: 'redis',
        questionBankKey: 'backend-redis-01',
      }),
    );
  });

  it('returns the next seed question without internal focus or fingerprints', async () => {
    const realtimeState = (
      session.interviewState as {
        realtime: { questionFingerprints: string[] };
      }
    ).realtime;
    realtimeState.questionFingerprints = ['design an api'];
    const pendingTurn = { ...currentTurn, answeredAt: null } as InterviewTurnEntity;
    const { service, turns, directives } = createService();
    (turns.findOne as jest.Mock).mockResolvedValue(pendingTurn);

    const result = await service.submitTurn('user-1', session.id, {
      clientTurnId: 'client-avoid-repeat',
      transcript:
        'I designed a REST API with idempotency keys, persisted the first response, added retries, monitored latency, and validated the approach under production traffic.',
      modality: 'AUDIO',
      intent: 'ANSWER',
      answerSignal: 'COMPLETE',
    });

    expect(result).toMatchObject({ fallbackQuestion: 'Design a cache.' });
    expect(result).not.toHaveProperty('questionGoal');
    expect(directives.create).toHaveBeenCalledWith(
      expect.objectContaining({ questionGoal: 'Design a cache.' }),
    );
    const created = (directives.create as jest.Mock).mock.calls[0][0] as {
      questionGoal: string;
    };
    expect(created.questionGoal).not.toMatch(/trade-offs|fingerprints|do not repeat/i);
  });

  it('downgrades a too-short COMPLETE answer and keeps one contextual follow-up in the same thread', async () => {
    const viSession = {
      ...session,
      language: 'vi',
      interviewState: {
        realtime: {
          topicId: 'api',
          questionThreadId: currentTurn.questionThreadId,
          difficultyStep: 0,
          noAnswerCount: 0,
          probeCount: 0,
          assistanceLevel: 'NONE',
          scoreCap: null,
          topicHistory: ['api'],
          questionFingerprints: [],
        },
      },
    } as InterviewSessionEntity;
    const { service, sessions, turns, directives } = createService();
    (sessions.findOne as jest.Mock).mockResolvedValue(viSession);
    (turns.findOne as jest.Mock).mockResolvedValue({
      ...currentTurn,
      interviewerQuestion:
        'Hãy giới thiệu ngắn về dự án gần nhất liên quan đến vị trí Frontend Developer. Bạn phụ trách phần nào?',
      currentThread: 'Role-only practice for React. No CV or job description was provided.',
    });

    const result = await service.submitTurn('user-1', session.id, {
      clientTurnId: 'client-short-answer',
      transcript: 'tôi phụ trách phần FE với 1 năm kinh nghiệm',
      modality: 'AUDIO',
      intent: 'ANSWER',
      answerSignal: 'COMPLETE',
    });

    expect(result.action).toBe('FOLLOW_UP');
    expect(result.questionThreadId).toBe(currentTurn.questionThreadId);
    expect(directives.create).toHaveBeenCalledWith(
      expect.objectContaining({
        answerSignal: 'PARTIAL',
        questionGoal: expect.stringMatching(/bạn|ví dụ|cụ thể/i),
      }),
    );
    const created = (directives.create as jest.Mock).mock.calls[0][0] as {
      questionGoal: string;
    };
    expect(created.questionGoal).not.toMatch(
      /Role-only practice|No CV or job description|fingerprints|scoreCap|questionGoal/i,
    );
    const normalizedGoal = Array.from(created.questionGoal.normalize('NFD'))
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code < 768 || code > 879;
      })
      .join('')
      .replaceAll(String.fromCharCode(273), 'd')
      .replaceAll(String.fromCharCode(272), 'd')
      .toLowerCase();
    expect(normalizedGoal).toMatch(/quyet dinh ky thuat|technical decision/i);
    expect(normalizedGoal).not.toMatch(/gom|va ket qua|including|and the result/i);
    expect(created.questionGoal.split('?')).toHaveLength(2);
  });
  it('does not reveal a session owned by another user', async () => {
    const { service, sessions } = createService();
    (sessions.findOne as jest.Mock).mockResolvedValue(null);

    await expect(
      service.submitTurn('other-user', session.id, {
        clientTurnId: 'client-2',
        transcript: 'answer',
        modality: 'TEXT',
        intent: 'ANSWER',
        answerSignal: 'COMPLETE',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
