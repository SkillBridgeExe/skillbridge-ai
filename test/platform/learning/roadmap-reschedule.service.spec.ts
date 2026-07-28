import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LearningModuleEntity } from '../../../src/database/entities/learning-module.entity';
import { LearningRoadmapEntity } from '../../../src/database/entities/learning-roadmap.entity';
import { LearningSessionEntity } from '../../../src/database/entities/learning-session.entity';
import { LearningSessionProgressEntity } from '../../../src/database/entities/learning-session-progress.entity';
import { LearningRoadmapRescheduleService } from '../../../src/platform/learning/roadmap-reschedule.service';

function setup(revision = 3) {
  const roadmap = {
    id: 'roadmap-1',
    userId: 'user-1',
    status: 'ACTIVE',
    revision,
    activeVersionId: 'version-1',
    draftConfig: {
      language_pref: 'en',
      candidate_skills: [],
      cadence: {
        timezone: 'Asia/Ho_Chi_Minh',
        start_date: '2026-08-03',
        study_days_per_week: 3,
        session_minutes: 60,
      },
    },
  };
  const modules = [
    { id: 'module-1', versionId: 'version-1', rank: 1 },
    { id: 'module-2', versionId: 'version-1', rank: 2 },
  ];
  const sessions = [
    {
      id: 'session-1',
      moduleId: 'module-1',
      sequence: 1,
      scheduledStartAt: new Date('2026-08-03T05:00:00.000Z'),
    },
    {
      id: 'session-2',
      moduleId: 'module-1',
      sequence: 2,
      scheduledStartAt: new Date('2026-08-05T05:00:00.000Z'),
    },
    {
      id: 'session-3',
      moduleId: 'module-2',
      sequence: 1,
      scheduledStartAt: new Date('2026-08-07T05:00:00.000Z'),
    },
  ];
  const manager = {
    findOne: jest.fn(async (entity) => (entity === LearningRoadmapEntity ? roadmap : null)),
    find: jest.fn(async (entity) => {
      if (entity === LearningModuleEntity) return modules;
      if (entity === LearningSessionEntity) return sessions;
      if (entity === LearningSessionProgressEntity) {
        return [
          {
            sessionId: 'session-1',
            checkedChecklistItems: { __session: ['completed'] },
          },
        ];
      }
      return [];
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = {
    transaction: jest.fn(async (callback) => callback(manager)),
  };
  const queries = {
    getActive: jest.fn().mockResolvedValue({ id: 'roadmap-1', revision: revision + 1 }),
  };
  const service = new LearningRoadmapRescheduleService(
    dataSource as unknown as DataSource,
    queries as never,
  );
  return { service, manager, queries, roadmap };
}

describe('LearningRoadmapRescheduleService', () => {
  it('keeps completed sessions immutable and redistributes only pending units', async () => {
    const { service, manager, queries } = setup();

    const result = await service.reschedule('user-1', 'roadmap-1', {
      expected_revision: 3,
      start_date: '2026-08-10',
      study_days_per_week: 2,
      session_minutes: 60,
    });

    expect(manager.update).not.toHaveBeenCalledWith(
      LearningSessionEntity,
      { id: 'session-1' },
      expect.anything(),
    );
    expect(manager.update).toHaveBeenCalledWith(
      LearningSessionEntity,
      { id: 'session-2' },
      { scheduledStartAt: new Date('2026-08-10T05:00:00.000Z') },
    );
    expect(manager.update).toHaveBeenCalledWith(
      LearningSessionEntity,
      { id: 'session-3' },
      { scheduledStartAt: new Date('2026-08-13T05:00:00.000Z') },
    );
    expect(manager.update).toHaveBeenCalledWith(
      LearningRoadmapEntity,
      { id: 'roadmap-1', userId: 'user-1', status: 'ACTIVE', revision: 3 },
      expect.objectContaining({
        revision: 4,
        draftConfig: expect.objectContaining({
          cadence: expect.objectContaining({
            start_date: '2026-08-10',
            study_days_per_week: 2,
          }),
        }),
      }),
    );
    expect(queries.getActive).toHaveBeenCalledWith('user-1', 'roadmap-1');
    expect(result).toEqual({ id: 'roadmap-1', revision: 4 });
  });

  it('rejects a stale revision before changing any session date', async () => {
    const { service, manager } = setup(4);

    await expect(
      service.reschedule('user-1', 'roadmap-1', {
        expected_revision: 3,
        start_date: '2026-08-10',
        study_days_per_week: 2,
        session_minutes: 60,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid persisted cadence timezone as a client error', async () => {
    const { service, manager, roadmap } = setup();
    roadmap.draftConfig.cadence.timezone = 'Invalid/Timezone';

    await expect(
      service.reschedule('user-1', 'roadmap-1', {
        expected_revision: 3,
        start_date: '2026-08-10',
        study_days_per_week: 2,
        session_minutes: 60,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('rejects a missing or unowned active roadmap before updating sessions', async () => {
    const { service, manager } = setup();
    manager.findOne.mockResolvedValue(null);

    await expect(
      service.reschedule('user-2', 'roadmap-1', {
        expected_revision: 3,
        start_date: '2026-08-10',
        study_days_per_week: 2,
        session_minutes: 60,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('rolls back when the optimistic roadmap update affects no row', async () => {
    const { service, manager } = setup();
    manager.update.mockImplementation(async (entity) => ({
      affected: entity === LearningRoadmapEntity ? 0 : 1,
    }));

    await expect(
      service.reschedule('user-1', 'roadmap-1', {
        expected_revision: 3,
        start_date: '2026-08-10',
        study_days_per_week: 2,
        session_minutes: 60,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
