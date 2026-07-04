import {
  answerQuizQuestion,
  computeObjectiveMastery,
} from '../../../src/platform/learning/quiz-mastery';

describe('learning quiz mastery', () => {
  it('scores the first attempt and keeps retries unscored', () => {
    const first = answerQuizQuestion(undefined, 1, 1, '2026-07-03T00:00:00.000Z');

    expect(first).toMatchObject({
      attempt: {
        selected_option_index: 1,
        is_correct: true,
        attempts: 1,
        answered_at: '2026-07-03T00:00:00.000Z',
        last_answered_at: '2026-07-03T00:00:00.000Z',
      },
      scored: true,
    });

    const retry = answerQuizQuestion(first.attempt, 0, 1, '2026-07-03T00:01:00.000Z');

    expect(retry).toMatchObject({
      attempt: {
        selected_option_index: 1,
        is_correct: true,
        attempts: 2,
        answered_at: '2026-07-03T00:00:00.000Z',
        last_answered_at: '2026-07-03T00:01:00.000Z',
      },
      scored: false,
    });
  });

  it('requires two correct answers and seventy percent accuracy for mastery', () => {
    const mastery = computeObjectiveMastery('react-state', [
      { questionId: 'q1', objectiveId: 'react-state', isCorrect: true },
      { questionId: 'q2', objectiveId: 'react-state', isCorrect: true },
      { questionId: 'q3', objectiveId: 'react-state', isCorrect: false },
    ]);

    expect(mastery).toEqual({
      objective_id: 'react-state',
      correct: 2,
      total_answered: 3,
      accuracy: 0.67,
      mastered: false,
    });
  });
});
