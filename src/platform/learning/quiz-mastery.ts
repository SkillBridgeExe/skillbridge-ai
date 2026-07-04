export interface QuizAttempt {
  selected_option_index: number;
  is_correct: boolean;
  attempts: number;
  answered_at: string;
  last_answered_at?: string;
}

export interface QuizAnswerResult {
  attempt: QuizAttempt;
  scored: boolean;
}

export interface ObjectiveQuestionResult {
  questionId: string;
  objectiveId: string;
  isCorrect: boolean;
}

export interface ObjectiveMastery {
  objective_id: string;
  correct: number;
  total_answered: number;
  accuracy: number;
  mastered: boolean;
}

export function answerQuizQuestion(
  existingAttempt: QuizAttempt | undefined,
  selectedOptionIndex: number,
  correctOptionIndex: number,
  answeredAt: string,
): QuizAnswerResult {
  if (existingAttempt) {
    return {
      attempt: {
        ...existingAttempt,
        attempts: Math.max(1, existingAttempt.attempts) + 1,
        last_answered_at: answeredAt,
      },
      scored: false,
    };
  }

  return {
    attempt: {
      selected_option_index: selectedOptionIndex,
      is_correct: selectedOptionIndex === correctOptionIndex,
      attempts: 1,
      answered_at: answeredAt,
      last_answered_at: answeredAt,
    },
    scored: true,
  };
}

export function computeObjectiveMastery(
  objectiveId: string,
  questionResults: ObjectiveQuestionResult[],
): ObjectiveMastery {
  const matching = questionResults.filter((result) => result.objectiveId === objectiveId);
  const correct = matching.filter((result) => result.isCorrect).length;
  const totalAnswered = matching.length;
  const accuracy = totalAnswered === 0 ? 0 : round2(correct / totalAnswered);

  return {
    objective_id: objectiveId,
    correct,
    total_answered: totalAnswered,
    accuracy,
    mastered: correct >= 2 && accuracy >= 0.7,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
