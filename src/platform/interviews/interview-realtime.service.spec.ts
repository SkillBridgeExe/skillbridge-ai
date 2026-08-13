import { ConflictException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { SkillTextScannerService } from '../../common/services/skill-text-scanner.service';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { InterviewChainLlmService } from './interview-chain-llm.service';
import { InterviewRealtimeService } from './interview-realtime.service';

function sessionFixture(overrides: Partial<InterviewSessionEntity> = {}): InterviewSessionEntity {
  return {
    id: 'session-1',
    userId: 'user-1',
    status: 'IN_PROGRESS',
    language: 'vi',
    mode: 'VOICE',
    experienceMode: 'MOCK',
    interviewType: 'TECHNICAL',
    targetRole: 'backend_developer',
    agenda: {
      topics: [
        { id: 'screening-1', phase: 'SCREENING', seed_question: 'Giới thiệu dự án gần nhất.' },
        {
          id: 'auth-1',
          phase: 'SKILL_PROBE',
          skill_canonical: 'jwt',
          what_to_probe: 'JWT, OAuth và session',
          seed_question: 'Bạn quản lý JWT và session như thế nào?',
        },
        { id: 'scenario-1', phase: 'SCENARIO', seed_question: 'Bạn xử lý sự cố ra sao?' },
      ],
    },
    interviewState: {
      realtime: {
        protocolVersion: 'interview-realtime-v3',
        currentTopicId: 'screening-1',
        topicHistory: [],
        questionFingerprints: [],
        probeCount: 0,
        noAnswerCount: 0,
        exchanges: [],
      },
    },
    contextSnapshot: null,
    ...overrides,
  } as InterviewSessionEntity;
}

function turnFixture(overrides: Partial<InterviewTurnEntity> = {}): InterviewTurnEntity {
  return {
    id: 'question-1',
    sessionId: 'session-1',
    turnOrder: 1,
    phase: 'SCREENING',
    topicPhase: 'SCREENING',
    modality: 'AUDIO',
    interviewerMessage: null,
    interviewerQuestion: 'Hãy giới thiệu dự án gần nhất. Bạn phụ trách phần nào?',
    userAnswerText: null,
    userAnswerTranscript: null,
    answeredAt: null,
    durationSeconds: null,
    responseDelayMs: null,
    transcriptSegments: null,
    clientTurnId: null,
    candidateIntent: null,
    questionThreadId: 'thread-1',
    assistanceLevel: 'NONE',
    scoreCap: null,
    skipReason: null,
    assistantResponseId: null,
    firstAudioAt: null,
    assistantInterrupted: false,
    currentThread: 'recent project ownership',
    skillCanonical: null,
    questionBankItemId: null,
    questionBankKey: null,
    timeBudgetSeconds: 90,
    ...overrides,
  } as InterviewTurnEntity;
}

function createHarness(
  options: {
    session?: InterviewSessionEntity;
    current?: InterviewTurnEntity | null;
  } = {},
) {
  const session = options.session ?? sessionFixture();
  let current = options.current === undefined ? turnFixture() : options.current;
  const savedTurns: InterviewTurnEntity[] = [];
  const sessions = {
    findOne: jest.fn(async () => session),
    save: jest.fn(async (value: InterviewSessionEntity) => value),
  };
  const turns = {
    findOne: jest.fn(async (query: { where?: Record<string, unknown> }) => {
      const where = query.where ?? {};
      if ('clientTurnId' in where) return null;
      if ('id' in where && current?.id !== where.id) return null;
      return current;
    }),
    find: jest.fn(async () => (current ? [current] : [])),
    create: jest.fn((value: Partial<InterviewTurnEntity>) => value as InterviewTurnEntity),
    save: jest.fn(async (value: InterviewTurnEntity) => {
      if (!value.id) value.id = `question-${value.turnOrder}`;
      savedTurns.push(value);
      if (!value.answeredAt) current = value;
      return value;
    }),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === InterviewSessionEntity ? sessions : turns,
    ),
    transaction: jest.fn(async (work: (value: EntityManager) => unknown) =>
      work(manager as unknown as EntityManager),
    ),
  } as unknown as EntityManager;
  const sessionsRepository = {
    ...sessions,
    manager,
  } as unknown as Repository<InterviewSessionEntity>;
  const turnsRepository = turns as unknown as Repository<InterviewTurnEntity>;
  const chain = { ask: jest.fn() } as unknown as InterviewChainLlmService;
  const scanner = {
    scan: jest.fn((value: string) =>
      /jwt|auth|session/i.test(value) ? [{ canonical_name: 'jwt' }] : [],
    ),
  } as unknown as SkillTextScannerService;
  const service = new InterviewRealtimeService(sessionsRepository, turnsRepository, chain, scanner);
  return { service, session, turns, sessions, savedTurns, chain };
}

const exchange = {
  kind: 'REALTIME_EXCHANGE' as const,
  clientTurnId: 'client-1',
  questionTurnId: 'question-1',
  input: {
    type: 'ANSWER' as const,
    modality: 'AUDIO' as const,
    transcript: 'Tôi phụ trách API auth, JWT và quản lý session.',
    intent: 'ANSWER' as const,
    intentSource: 'VOICE_LEXICAL' as const,
    itemIds: ['item-1'],
    speechStartedAt: '2026-08-13T10:00:00.000Z',
    speechEndedAt: '2026-08-13T10:00:05.000Z',
    segmentCount: 2,
    meanLogprob: -0.25,
  },
  assistant: {
    responseId: 'resp-1',
    transcript: 'Bạn vừa nhắc đến JWT và session. Bạn xử lý refresh token như thế nào?',
    firstAudioAt: '2026-08-13T10:00:05.800Z',
    interrupted: false,
  },
};

describe('InterviewRealtimeService v3 exchange', () => {
  it('atomically answers the active turn and persists the actual next question', async () => {
    const { service, turns, sessions, savedTurns } = createHarness();

    const result = await service.submitTurn('user-1', 'session-1', exchange);

    expect(result).toMatchObject({
      disposition: 'COMMITTED',
      answeredTurnId: 'question-1',
      currentTurnId: 'question-2',
      assistant: { responseId: 'resp-1', question: 'Bạn xử lý refresh token như thế nào?' },
    });
    expect(turns.save).toHaveBeenCalledTimes(2);
    expect(savedTurns[0]).toMatchObject({
      clientTurnId: 'client-1',
      userAnswerText: 'Tôi phụ trách API auth, JWT và quản lý session.',
      assistantResponseId: 'resp-1',
    });
    expect(savedTurns[1]).toMatchObject({
      skillCanonical: 'jwt',
      questionBankItemId: null,
      questionBankKey: null,
    });
    expect(sessions.save).toHaveBeenCalledTimes(1);
  });

  it('returns a remembered exchange as DUPLICATE without creating another turn', async () => {
    const session = sessionFixture({
      interviewState: {
        realtime: {
          protocolVersion: 'interview-realtime-v3',
          currentTopicId: 'auth-1',
          topicHistory: ['screening-1'],
          questionFingerprints: [],
          probeCount: 0,
          noAnswerCount: 0,
          exchanges: [
            {
              clientTurnId: 'client-1',
              disposition: 'COMMITTED',
              answeredTurnId: 'question-1',
              currentTurnId: 'question-2',
              responseId: 'resp-1',
              transcript: 'Câu trả lời đã lưu.',
              question: 'Câu tiếp theo?',
              finished: false,
            },
          ],
        },
      },
    });
    const { service, turns } = createHarness({ session });

    const result = await service.submitTurn('user-1', 'session-1', exchange);

    expect(result.disposition).toBe('DUPLICATE');
    expect(turns.save).not.toHaveBeenCalled();
  });

  it('does not consume an attempt for CAPTURE_RETRY', async () => {
    const { service, turns } = createHarness();

    const result = await service.submitTurn('user-1', 'session-1', {
      ...exchange,
      clientTurnId: 'capture-1',
      input: {
        ...exchange.input,
        type: 'CAPTURE_RETRY',
        transcript: 'phần nguyên lý ánh sáng',
      },
      assistant: {
        ...exchange.assistant,
        responseId: 'resp-retry',
        transcript: 'Mình chưa nghe rõ. Bạn có thể nói lại câu trả lời vừa rồi không?',
      },
    });

    expect(result).toMatchObject({ disposition: 'CAPTURE_RETRY', answeredTurnId: null });
    expect(turns.save).not.toHaveBeenCalled();
  });

  it('keeps the same turn for repeat and easier controls', async () => {
    const { service, turns } = createHarness();

    const result = await service.submitTurn('user-1', 'session-1', {
      ...exchange,
      clientTurnId: 'control-1',
      input: {
        ...exchange.input,
        type: 'CONTROL',
        intent: 'EASIER',
        intentSource: 'BUTTON',
        transcript: undefined,
      },
      assistant: {
        ...exchange.assistant,
        responseId: 'resp-control',
        transcript: 'Bạn đã trực tiếp làm tính năng backend nào trong dự án gần nhất?',
      },
    });

    expect(result).toMatchObject({
      disposition: 'CONTROL_APPLIED',
      answeredTurnId: null,
      currentTurnId: 'question-1',
    });
    expect(turns.save).toHaveBeenCalledTimes(1);
    expect(turns.save.mock.calls[0][0]).toMatchObject({ assistanceLevel: 'EASIER', scoreCap: 75 });
  });

  it('keeps a pending fallback question when playback is interrupted before a question is complete', async () => {
    const { service, savedTurns } = createHarness();

    const result = await service.submitTurn('user-1', 'session-1', {
      ...exchange,
      assistant: {
        ...exchange.assistant,
        transcript: 'Cảm ơn bạn đã chia sẻ về phần API auth.',
        interrupted: true,
      },
    });

    expect(result).toMatchObject({
      disposition: 'COMMITTED',
      currentTurnId: 'question-2',
      finished: false,
      assistant: { question: 'Bạn quản lý JWT và session như thế nào?' },
    });
    expect(savedTurns[1]).toMatchObject({
      interviewerQuestion: 'Bạn quản lý JWT và session như thế nào?',
      skillCanonical: 'jwt',
    });
  });
  it('returns a structured stale-question error instead of no pending question text', async () => {
    const { service } = createHarness({ current: null });

    const promise = service.submitTurn('user-1', 'session-1', exchange);
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({
      response: { errorCode: 'INTERVIEW_STALE_QUESTION' },
    });
  });
});
