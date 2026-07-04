import { Repository } from 'typeorm';
import { LearningSessionProgressEntity } from '../../../src/database/entities/learning-session-progress.entity';
import { LearningSessionProgressService } from '../../../src/platform/learning/session-progress.service';

type RepoMock = Pick<Repository<LearningSessionProgressEntity>, 'create' | 'findOne' | 'save'> & {
  create: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
};

function repoMock(): RepoMock {
  return {
    create: jest.fn((value) => value),
    findOne: jest.fn(),
    save: jest.fn((value) =>
      Promise.resolve({ ...value, updatedAt: new Date('2026-06-23T10:00:00.000Z') }),
    ),
  } as RepoMock;
}

describe('LearningSessionProgressService', () => {
  it('returns empty progress when the user has not started a session', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue(null);
    const service = new LearningSessionProgressService(
      repo as unknown as Repository<LearningSessionProgressEntity>,
    );

    await expect(service.getProgress('user-1', 'roadmap-react')).resolves.toEqual({
      session_id: 'roadmap-react',
      checked_checklist_items: {},
      exercise_proofs: {},
      quiz_attempts: {},
      updated_at: null,
    });
  });

  it('creates a user-scoped progress row with checked items and exercise proof', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue(null);
    const service = new LearningSessionProgressService(
      repo as unknown as Repository<LearningSessionProgressEntity>,
    );

    const result = await service.saveProgress('user-1', 'roadmap-react', {
      checked_checklist_items: { intro: ['Create a component'] },
      exercise_proofs: { build: 'https://portfolio.example/react-proof' },
    });

    expect(repo.create).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: 'roadmap-react',
      checkedChecklistItems: { intro: ['Create a component'] },
      exerciseProofs: { build: 'https://portfolio.example/react-proof' },
    });
    expect(repo.save).toHaveBeenCalled();
    expect(result).toEqual({
      session_id: 'roadmap-react',
      checked_checklist_items: { intro: ['Create a component'] },
      exercise_proofs: { build: 'https://portfolio.example/react-proof' },
      quiz_attempts: {},
      updated_at: '2026-06-23T10:00:00.000Z',
    });
  });

  it('updates the existing row for the same user and session instead of creating another one', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({
      id: 'progress-1',
      userId: 'user-1',
      sessionId: 'roadmap-react',
      checkedChecklistItems: {},
      exerciseProofs: {},
      updatedAt: new Date('2026-06-23T09:00:00.000Z'),
    });
    const service = new LearningSessionProgressService(
      repo as unknown as Repository<LearningSessionProgressEntity>,
    );

    await service.saveProgress('user-1', 'roadmap-react', {
      checked_checklist_items: { intro: ['Create a component'] },
      exercise_proofs: {},
    });

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'progress-1',
        checkedChecklistItems: { intro: ['Create a component'] },
        exerciseProofs: {},
      }),
    );
  });

  it('preserves saved quiz answers when checklist and proof progress are saved later', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({
      id: 'progress-1',
      userId: 'user-1',
      sessionId: 'roadmap-react',
      checkedChecklistItems: {},
      exerciseProofs: {},
      quizAttempts: {
        'state-purpose': {
          selected_option_index: 0,
          is_correct: true,
          attempts: 1,
          answered_at: '2026-07-03T00:00:00.000Z',
        },
      },
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    const service = new LearningSessionProgressService(
      repo as unknown as Repository<LearningSessionProgressEntity>,
    );

    const result = await service.saveProgress('user-1', 'roadmap-react', {
      checked_checklist_items: { intro: ['Create a component'] },
      exercise_proofs: { build: 'Screenshot saved in notes.' },
    });

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        quizAttempts: {
          'state-purpose': expect.objectContaining({
            selected_option_index: 0,
            is_correct: true,
            attempts: 1,
          }),
        },
      }),
    );
    expect(result.quiz_attempts).toEqual({
      'state-purpose': expect.objectContaining({
        selected_option_index: 0,
        is_correct: true,
        attempts: 1,
      }),
    });
  });

  it('scores the first quiz attempt on the server and persists it', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue(null);
    const service = new LearningSessionProgressService(
      repo as unknown as Repository<LearningSessionProgressEntity>,
    );

    const result = await service.answerQuizQuestion('user-1', 'roadmap-react', {
      skill_canonical: 'react',
      question_id: 'state-purpose',
      selected_option_index: 0,
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sessionId: 'roadmap-react',
        quizAttempts: {
          'state-purpose': expect.objectContaining({
            selected_option_index: 0,
            is_correct: true,
            attempts: 1,
          }),
        },
      }),
    );
    expect(result).toMatchObject({
      question_id: 'state-purpose',
      selected_option_index: 0,
      is_correct: true,
      scored: true,
      attempt_count: 1,
      correct_option_index: 0,
      explanation:
        'Local state is for UI data owned by the component, especially values changed by user interaction.',
      objective_mastery: {
        objective_id: 'react-state-events',
        correct: 1,
        total_answered: 1,
        accuracy: 1,
        mastered: false,
      },
      lesson_status: 'in_progress',
      remediation: {
        section_id: 'state-events',
      },
    });
  });

  it('keeps retry answers unscored and preserves first-attempt correctness', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({
      id: 'progress-1',
      userId: 'user-1',
      sessionId: 'roadmap-react',
      checkedChecklistItems: {},
      exerciseProofs: {},
      quizAttempts: {
        'state-purpose': {
          selected_option_index: 0,
          is_correct: true,
          attempts: 1,
          answered_at: '2026-07-03T00:00:00.000Z',
        },
      },
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    const service = new LearningSessionProgressService(
      repo as unknown as Repository<LearningSessionProgressEntity>,
    );

    const result = await service.answerQuizQuestion('user-1', 'roadmap-react', {
      skill_canonical: 'react',
      question_id: 'state-purpose',
      selected_option_index: 2,
    });

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        quizAttempts: {
          'state-purpose': expect.objectContaining({
            selected_option_index: 0,
            is_correct: true,
            attempts: 2,
          }),
        },
      }),
    );
    expect(result).toMatchObject({
      selected_option_index: 0,
      is_correct: true,
      scored: false,
      attempt_count: 2,
    });
  });

  it('returns adaptive next questions for weak objectives', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({
      id: 'progress-1',
      userId: 'user-1',
      sessionId: 'roadmap-react',
      checkedChecklistItems: {},
      exerciseProofs: {},
      quizAttempts: {
        'state-purpose': {
          selected_option_index: 1,
          is_correct: false,
          attempts: 1,
          answered_at: '2026-07-03T00:00:00.000Z',
        },
      },
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    const service = new LearningSessionProgressService(
      repo as unknown as Repository<LearningSessionProgressEntity>,
    );

    await expect(service.getNextQuestions('user-1', 'roadmap-react', 'react')).resolves.toEqual({
      weak_objectives: [
        {
          objective_id: 'react-state-events',
          correct: 0,
          total_answered: 1,
          accuracy: 0,
          mastered: false,
        },
      ],
      next_recommended_questions: expect.arrayContaining([
        expect.objectContaining({
          id: 'immutable-state',
          objective_id: 'react-state-events',
          section_id: 'state-events',
        }),
      ]),
    });
  });

  it('patches one checklist item by stable id without overwriting sibling items', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({
      id: 'progress-1',
      userId: 'user-1',
      sessionId: 'roadmap-react',
      checkedChecklistItems: {
        'state-events': ['state-events-add-a-click-or-form-event-handler'],
      },
      exerciseProofs: {},
      quizAttempts: {},
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    const service = new LearningSessionProgressService(
      repo as unknown as Repository<LearningSessionProgressEntity>,
    );

    await service.patchChecklistItem(
      'user-1',
      'roadmap-react',
      'state-events-update-state-without-mutating-the-existing-value',
      {
        section_id: 'state-events',
        checked: true,
      },
    );

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        checkedChecklistItems: {
          'state-events': [
            'state-events-add-a-click-or-form-event-handler',
            'state-events-update-state-without-mutating-the-existing-value',
          ],
        },
      }),
    );
  });
});
