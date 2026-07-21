import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { LearningRoadmapEntity } from '../../../src/database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../../src/database/entities/learning-roadmap-version.entity';
import { LearningModuleEntity } from '../../../src/database/entities/learning-module.entity';
import { LearningSessionEntity } from '../../../src/database/entities/learning-session.entity';
import { LearningRoadmapGenerationService } from '../../../src/platform/learning/roadmap-generation.service';

const draft = (): LearningRoadmapEntity =>
  ({
    id: 'roadmap-1',
    userId: 'user-1',
    intent: 'CAREER_ROLE',
    status: 'DRAFT',
    revision: 2,
    cvMatchId: null,
    targetRole: 'frontend_developer',
    targetLevel: 'fresher',
    activeVersionId: null,
    draftConfig: {
      language_pref: 'both',
      source_cv_id: 'cv-1',
      candidate_skills: [
        {
          skill_canonical: 'typescript',
          display_name: 'TypeScript',
          system_priority: 0.8,
          rationale: 'Required for the role.',
          prerequisites: [],
        },
      ],
      selected_priorities: [{ skill_canonical: 'typescript', rank: 1 }],
      schedule: {
        timezone: 'Asia/Ho_Chi_Minh',
        deadline: '2026-08-31',
        session_minutes: 60,
        slots: [{ iso_weekday: 1, start_time: '19:00', duration_minutes: 60 }],
      },
    },
  }) as unknown as LearningRoadmapEntity;

function setup() {
  const roadmaps = { findOne: jest.fn().mockResolvedValue(draft()) };
  const drafts = {
    rederiveCurrentCandidates: jest.fn().mockResolvedValue({
      targetRole: 'frontend_developer',
      candidates: draft().draftConfig.candidate_skills,
      sourceGapSnapshot: { source: 'career_role', skills: ['typescript'] },
    }),
  };
  const composer = {
    compose: jest.fn().mockReturnValue({
      budget_hours: 100,
      ai_summary: 'Focus on TypeScript.',
      not_feasible_items: [],
      steps: [
        {
          skill_canonical: 'typescript',
          display_name: 'TypeScript',
          estimated_hours: 2,
          priority: 0.8,
          resources: [{ id: 'resource-1', title: 'TypeScript handbook' }],
          lesson_content: { overview: 'Learn TypeScript.' },
        },
      ],
    }),
  };
  const reservation = {
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const entitlements = {
    reserveUsage: jest.fn().mockResolvedValue(reservation),
  };
  let nextId = 0;
  const manager = {
    findOne: jest.fn().mockResolvedValue(draft()),
    create: jest.fn((_entity, value) => value),
    save: jest.fn(async (entity, value) => ({
      ...value,
      id:
        entity === LearningRoadmapVersionEntity
          ? 'version-1'
          : entity === LearningModuleEntity
            ? 'module-1'
            : entity === LearningSessionEntity
              ? `session-${++nextId}`
              : `saved-${++nextId}`,
    })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = {
    transaction: jest.fn(async (callback) => callback(manager)),
  };
  const service = new LearningRoadmapGenerationService(
    roadmaps as unknown as Repository<LearningRoadmapEntity>,
    dataSource as unknown as DataSource,
    drafts as never,
    composer as never,
    entitlements as never,
  );
  return { service, roadmaps, drafts, composer, entitlements, reservation, dataSource, manager };
}

describe('LearningRoadmapGenerationService', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-07-21T00:00:00.000Z')));
  afterEach(() => jest.useRealTimers());

  it('previews a real dated schedule without charging quota or writing data', async () => {
    const { service, entitlements, dataSource } = setup();

    const result = await service.preview('user-1', 'roadmap-1', 2);

    expect(result.modules).toEqual([
      expect.objectContaining({ skill_canonical: 'typescript', feasibility: 'FEASIBLE' }),
    ]);
    expect(result.sessions[0]).toEqual(
      expect.objectContaining({
        skill_canonical: 'typescript',
        scheduled_start_at: '2026-07-27T12:00:00.000Z',
      }),
    );
    expect(entitlements.reserveUsage).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('refuses preview when the draft revision is stale or no schedule was saved', async () => {
    const { service, roadmaps } = setup();
    await expect(service.preview('user-1', 'roadmap-1', 1)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const withoutSchedule = draft();
    delete withoutSchedule.draftConfig.schedule;
    roadmaps.findOne.mockResolvedValue(withoutSchedule);
    await expect(service.preview('user-1', 'roadmap-1', 2)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('persists an immutable version, modules and sessions in one transaction then charges once', async () => {
    const { service, entitlements, reservation, manager } = setup();

    const result = await service.generate('user-1', 'roadmap-1', 2);

    expect(entitlements.reserveUsage).toHaveBeenCalledTimes(1);
    expect(manager.findOne).toHaveBeenCalledWith(
      LearningRoadmapEntity,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      LearningRoadmapVersionEntity,
      expect.objectContaining({ roadmapId: 'roadmap-1', versionNo: 1 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      LearningModuleEntity,
      expect.objectContaining({ versionId: 'version-1', skillCanonical: 'typescript' }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      LearningSessionEntity,
      expect.objectContaining({ moduleId: 'module-1' }),
    );
    expect(manager.update).toHaveBeenCalledWith(
      LearningRoadmapEntity,
      { id: 'roadmap-1', userId: 'user-1', status: 'DRAFT', revision: 2 },
      { status: 'ACTIVE', activeVersionId: 'version-1', revision: 3 },
    );
    expect(reservation.confirm).toHaveBeenCalledWith({
      sourceType: 'learning_roadmap',
      sourceId: 'roadmap-1',
    });
    expect(result.version_id).toBe('version-1');
  });

  it('refunds quota when transactional persistence fails', async () => {
    const { service, dataSource, reservation } = setup();
    dataSource.transaction.mockRejectedValue(new Error('database unavailable'));

    await expect(service.generate('user-1', 'roadmap-1', 2)).rejects.toThrow(
      'database unavailable',
    );
    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });
});
