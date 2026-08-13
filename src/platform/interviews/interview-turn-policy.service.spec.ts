import {
  InterviewTurnPolicyService,
  type RealtimeTurnPolicyInput,
  type RealtimeTurnPolicyState,
} from './interview-turn-policy.service';

const initialState = (
  overrides: Partial<RealtimeTurnPolicyState> = {},
): RealtimeTurnPolicyState => ({
  topicId: 'topic-api-design',
  questionThreadId: '11111111-1111-4111-8111-111111111111',
  difficultyStep: 0,
  noAnswerCount: 0,
  probeCount: 0,
  assistanceLevel: 'NONE',
  scoreCap: null,
  ...overrides,
});

const input = (overrides: Partial<RealtimeTurnPolicyInput> = {}): RealtimeTurnPolicyInput => ({
  experienceMode: 'MOCK',
  intent: 'ANSWER',
  answerSignal: 'COMPLETE',
  state: initialState(),
  nextTopicId: 'topic-database',
  nextQuestionThreadId: '22222222-2222-4222-8222-222222222222',
  ...overrides,
});

describe('InterviewTurnPolicyService', () => {
  const policy = new InterviewTurnPolicyService();

  it('lowers difficulty once on the first no-answer and caps the thread at 75', () => {
    const result = policy.decide(input({ intent: 'NO_ANSWER', answerSignal: 'NO_ANSWER' }));

    expect(result).toMatchObject({
      action: 'LOWER_DIFFICULTY',
      consumesAttempt: true,
      finished: false,
      assistanceLevel: 'EASIER',
      scoreCap: 75,
      threadScore: null,
      state: {
        topicId: 'topic-api-design',
        questionThreadId: '11111111-1111-4111-8111-111111111111',
        difficultyStep: -1,
        noAnswerCount: 1,
      },
    });
  });
  it('retries an invalid audio capture without consuming or changing the thread', () => {
    const state = initialState({ probeCount: 1 });
    const result = policy.decide(input({ captureInvalid: true, state }));

    expect(result).toMatchObject({
      action: 'RETRY_CAPTURE',
      consumesAttempt: false,
      finished: false,
      state,
    });
  });

  it('moves to a different topic after the second no-answer and scores the thread zero', () => {
    const result = policy.decide(
      input({
        intent: 'NO_ANSWER',
        answerSignal: 'NO_ANSWER',
        state: initialState({
          difficultyStep: -1,
          noAnswerCount: 1,
          assistanceLevel: 'EASIER',
          scoreCap: 75,
        }),
      }),
    );

    expect(result).toMatchObject({
      action: 'ADVANCE_TOPIC',
      consumesAttempt: true,
      finished: false,
      threadScore: 0,
      state: {
        topicId: 'topic-database',
        questionThreadId: '22222222-2222-4222-8222-222222222222',
        difficultyStep: 0,
        noAnswerCount: 0,
        probeCount: 0,
        assistanceLevel: 'NONE',
        scoreCap: null,
      },
    });
  });

  it('replaces a question with an easier one without recording a zero attempt', () => {
    const result = policy.decide(input({ intent: 'EASIER' }));

    expect(result.action).toBe('LOWER_DIFFICULTY');
    expect(result.consumesAttempt).toBe(false);
    expect(result.threadScore).toBeNull();
    expect(result.state.scoreCap).toBe(75);
  });

  it('gives a hint only in practice mode and applies the stricter 60 cap', () => {
    const result = policy.decide(
      input({
        experienceMode: 'PRACTICE',
        intent: 'HINT',
        state: initialState({ assistanceLevel: 'EASIER', scoreCap: 75 }),
      }),
    );

    expect(result).toMatchObject({
      action: 'GIVE_HINT',
      consumesAttempt: false,
      assistanceLevel: 'HINT',
      scoreCap: 60,
      state: {
        assistanceLevel: 'HINT',
        scoreCap: 60,
      },
    });
  });

  it('turns a hint request in mock mode into an easier question without revealing a hint', () => {
    const result = policy.decide(input({ intent: 'HINT' }));

    expect(result).toMatchObject({
      action: 'LOWER_DIFFICULTY',
      consumesAttempt: false,
      assistanceLevel: 'EASIER',
      scoreCap: 75,
    });
  });

  it('skips the current thread with zero and advances to a fresh topic state', () => {
    const result = policy.decide(input({ intent: 'SKIP' }));

    expect(result).toMatchObject({
      action: 'ADVANCE_TOPIC',
      consumesAttempt: true,
      threadScore: 0,
      state: {
        topicId: 'topic-database',
        questionThreadId: '22222222-2222-4222-8222-222222222222',
        assistanceLevel: 'NONE',
        scoreCap: null,
      },
    });
  });

  it.each(['REPEAT', 'CLARIFY'] as const)(
    '%s does not consume an attempt or mutate the thread state',
    (intent) => {
      const state = initialState({ probeCount: 1 });
      const result = policy.decide(input({ intent, state }));

      expect(result.consumesAttempt).toBe(false);
      expect(result.state).toEqual(state);
      expect(result.threadScore).toBeNull();
    },
  );

  it('allows one contextual probe for a partial answer, then advances', () => {
    const first = policy.decide(input({ answerSignal: 'PARTIAL' }));
    const second = policy.decide(input({ answerSignal: 'PARTIAL', state: first.state }));

    expect(first.action).toBe('FOLLOW_UP');
    expect(first.state.probeCount).toBe(1);
    expect(second.action).toBe('ADVANCE_TOPIC');
  });

  it('wraps instead of inventing another question when no topic remains', () => {
    const result = policy.decide(input({ nextTopicId: null, nextQuestionThreadId: null }));

    expect(result).toMatchObject({
      action: 'WRAP_UP',
      finished: true,
      consumesAttempt: true,
    });
  });
});
