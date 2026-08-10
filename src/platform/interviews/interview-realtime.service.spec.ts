import { NotFoundException } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import { InterviewRealtimeDirectiveEntity } from '../../database/entities/interview-realtime-directive.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { InterviewRealtimeService } from './interview-realtime.service';
import { InterviewTurnPolicyService } from './interview-turn-policy.service';

type RepoMock<T extends ObjectLiteral> = Pick<Repository<T>, 'findOne' | 'create' | 'save'>;

describe('InterviewRealtimeService', () => {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    status: 'IN_PROGRESS',
    engineVersion: 'V2',
    experienceMode: 'MOCK',
    agenda: {
      topics: [
        { id: 'api', what_to_probe: 'API trade-offs', seed_question: 'Design an API.' },
        { id: 'cache', what_to_probe: 'Cache trade-offs', seed_question: 'Design a cache.' },
      ],
    },
    interviewState: {
      realtimeV2: {
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

  it('adds recent question fingerprints to a new question directive', async () => {
    const realtimeState = (
      session.interviewState as {
        realtimeV2: { questionFingerprints: string[] };
      }
    ).realtimeV2;
    realtimeState.questionFingerprints = ['design an api'];
    const pendingTurn = { ...currentTurn, answeredAt: null } as InterviewTurnEntity;
    const { service, turns, directives } = createService();
    (turns.findOne as jest.Mock).mockResolvedValue(pendingTurn);

    await service.submitTurn('user-1', session.id, {
      clientTurnId: 'client-avoid-repeat',
      transcript: 'I use idempotency keys and persist the first response.',
      modality: 'AUDIO',
      intent: 'ANSWER',
      answerSignal: 'COMPLETE',
    });

    expect(directives.create).toHaveBeenCalledWith(
      expect.objectContaining({
        questionGoal: expect.stringContaining(
          'do not repeat these recent question fingerprints: design an api',
        ),
      }),
    );
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
