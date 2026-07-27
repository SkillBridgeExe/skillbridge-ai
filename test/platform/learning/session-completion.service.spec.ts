import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { LearningModuleEntity } from '../../../src/database/entities/learning-module.entity';
import { LearningRoadmapEntity } from '../../../src/database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../../src/database/entities/learning-roadmap-version.entity';
import { LearningSessionProgressEntity } from '../../../src/database/entities/learning-session-progress.entity';
import { LearningSessionEntity } from '../../../src/database/entities/learning-session.entity';
import { LearningSessionCompletionService } from '../../../src/platform/learning/session-completion.service';

function completionHarness(options?: {
  targetSessionId?: string;
  targetModuleId?: string;
  targetProgress?: Record<string, unknown>;
  completedSessionIds?: string[];
  roadmapOwned?: boolean;
}) {
  const targetSessionId = options?.targetSessionId ?? 'session-2';
  const targetModuleId = options?.targetModuleId ?? 'module-1';
  const completedSessionIds = options?.completedSessionIds ?? ['session-1'];
  const modules = [
    { id: 'module-1', versionId: 'version-1', rank: 1 },
    { id: 'module-2', versionId: 'version-1', rank: 2 },
  ];
  const sessions = [
    {
      id: 'session-1',
      moduleId: 'module-1',
      sequence: 1,
      requiredTasks: [],
    },
    {
      id: 'session-2',
      moduleId: 'module-1',
      sequence: 2,
      requiredTasks: [
        {
          type: 'lesson',
          content: {
            sections: [{ id: 'semantic-html', checklist: [{ id: 'use-landmarks' }] }],
            exercises: [{ id: 'build-form' }],
          },
        },
      ],
    },
    {
      id: 'session-3',
      moduleId: 'module-2',
      sequence: 1,
      requiredTasks: [],
    },
    {
      id: 'session-4',
      moduleId: 'module-2',
      sequence: 2,
      requiredTasks: [],
    },
  ];
  const progressRows = [
    ...completedSessionIds.map((sessionId) => ({
      id: `progress-${sessionId}`,
      userId: 'user-1',
      sessionId,
      learningSessionId: sessionId,
      revision: 1,
      checkedChecklistItems: { __session: ['completed'] },
      exerciseProofs: {},
      quizAttempts: {},
    })),
    {
      id: `progress-${targetSessionId}`,
      userId: 'user-1',
      sessionId: targetSessionId,
      learningSessionId: targetSessionId,
      revision: 2,
      checkedChecklistItems: {
        'semantic-html': ['use-landmarks'],
      },
      exerciseProofs: {
        'task:semantic-html:use-landmarks': 'Used semantic HTML landmarks.',
        'build-form': 'https://example.test/form-proof',
      },
      quizAttempts: {},
      ...options?.targetProgress,
    },
  ];

  const sessionRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue(sessions.find((session) => session.id === targetSessionId)),
    find: jest.fn().mockResolvedValue(sessions),
  };
  const moduleRepo = {
    findOne: jest.fn().mockResolvedValue(modules.find((module) => module.id === targetModuleId)),
    find: jest.fn().mockResolvedValue(modules),
  };
  const versionRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'version-1', roadmapId: 'roadmap-1' }),
  };
  const roadmapRepo = {
    findOne: jest.fn().mockResolvedValue(
      options?.roadmapOwned === false
        ? null
        : {
            id: 'roadmap-1',
            userId: 'user-1',
            status: 'ACTIVE',
            activeVersionId: 'version-1',
          },
    ),
  };
  const progressRepo = {
    find: jest.fn().mockResolvedValue(progressRows),
    findOne: jest
      .fn()
      .mockResolvedValue(progressRows.find((row) => row.sessionId === targetSessionId)),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
  };
  const repositories = new Map<unknown, unknown>([
    [LearningSessionEntity, sessionRepo],
    [LearningModuleEntity, moduleRepo],
    [LearningRoadmapVersionEntity, versionRepo],
    [LearningRoadmapEntity, roadmapRepo],
    [LearningSessionProgressEntity, progressRepo],
  ]);
  const manager = {
    getRepository: jest.fn((entity) => repositories.get(entity)),
  };
  const dataSource = {
    transaction: jest.fn(async (callback) => callback(manager)),
  };
  return {
    service: new LearningSessionCompletionService(dataSource as never),
    progressRepo,
    roadmapRepo,
  };
}

describe('LearningSessionCompletionService', () => {
  it('completes the final session in a module and unlocks every session in the next module', async () => {
    const { service, progressRepo, roadmapRepo } = completionHarness();

    await expect(service.complete('user-1', 'session-2')).resolves.toEqual({
      session_id: 'session-2',
      status: 'COMPLETED',
      module_completed: true,
      next_session_id: 'session-3',
      unlocked_session_ids: ['session-3', 'session-4'],
    });
    expect(progressRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 3,
        checkedChecklistItems: expect.objectContaining({
          __session: ['completed'],
        }),
      }),
    );
    expect(roadmapRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        lock: { mode: 'pessimistic_write' },
      }),
    );
  });

  it('rejects completion while required proof is missing', async () => {
    const { service } = completionHarness({
      targetProgress: {
        exerciseProofs: {
          'task:semantic-html:use-landmarks': 'short',
        },
      },
    });

    const completion = service.complete('user-1', 'session-2');
    await expect(completion).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(completion).rejects.toMatchObject({
      response: {
        errors: {
          missing_checklist_item_ids: ['semantic-html:use-landmarks'],
          missing_exercise_ids: ['build-form'],
          missing_section_ids: [],
        },
      },
    });
  });

  it('rejects completion for a session in a future locked module', async () => {
    const { service } = completionHarness({
      targetSessionId: 'session-3',
      targetModuleId: 'module-2',
      completedSessionIds: [],
    });

    await expect(service.complete('user-1', 'session-3')).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not reveal or complete a session outside the active owned roadmap', async () => {
    const { service, progressRepo } = completionHarness({
      roadmapOwned: false,
    });

    await expect(service.complete('user-2', 'session-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(progressRepo.save).not.toHaveBeenCalled();
  });
});
