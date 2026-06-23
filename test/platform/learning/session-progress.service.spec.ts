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
    save: jest.fn((value) => Promise.resolve({ ...value, updatedAt: new Date('2026-06-23T10:00:00.000Z') })),
  } as RepoMock;
}

describe('LearningSessionProgressService', () => {
  it('returns empty progress when the user has not started a session', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue(null);
    const service = new LearningSessionProgressService(repo as unknown as Repository<LearningSessionProgressEntity>);

    await expect(service.getProgress('user-1', 'roadmap-react')).resolves.toEqual({
      session_id: 'roadmap-react',
      checked_checklist_items: {},
      exercise_proofs: {},
      updated_at: null,
    });
  });

  it('creates a user-scoped progress row with checked items and exercise proof', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue(null);
    const service = new LearningSessionProgressService(repo as unknown as Repository<LearningSessionProgressEntity>);

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
    const service = new LearningSessionProgressService(repo as unknown as Repository<LearningSessionProgressEntity>);

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
});
