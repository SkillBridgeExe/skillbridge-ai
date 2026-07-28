import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { LearningRoadmapEntity } from '../../../src/database/entities/learning-roadmap.entity';
import { LearningRoadmapQueryService } from '../../../src/platform/learning/roadmap-query.service';

describe('LearningRoadmapQueryService', () => {
  it('exposes an archive operation for the current active roadmap', () => {
    const service = new LearningRoadmapQueryService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(typeof (service as unknown as { archiveActive?: unknown }).archiveActive).toBe(
      'function',
    );
  });

  it('archives only the current user active roadmap without deleting history', async () => {
    const roadmaps = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn(),
    };
    const service = new LearningRoadmapQueryService(
      roadmaps as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.archiveActive('user-1')).resolves.toEqual({ archived: 1 });
    expect(roadmaps.update).toHaveBeenCalledWith(
      { userId: 'user-1', status: 'ACTIVE' },
      { status: 'ARCHIVED' },
    );
    expect(roadmaps.delete).not.toHaveBeenCalled();
  });

  it('returns only the owned active version with ordered modules and sessions', async () => {
    const roadmaps = {
      findOne: jest.fn().mockResolvedValue({
        id: 'roadmap-1',
        userId: 'user-1',
        status: 'ACTIVE',
        activeVersionId: 'version-1',
        intent: 'CAREER_ROLE',
        targetRole: 'frontend_developer',
        targetLevel: 'fresher',
        revision: 3,
        draftConfig: {
          cadence: {
            timezone: 'Asia/Ho_Chi_Minh',
            start_date: '2026-07-20',
            study_days_per_week: 3,
            session_minutes: 60,
          },
        },
      }),
    };
    const versions = {
      findOne: jest.fn().mockResolvedValue({
        id: 'version-1',
        versionNo: 1,
        resourceCatalogVersion: 'catalog-v1',
        contentVersion: 'content-v1',
        inputSnapshot: {
          generated_plan: {
            learning_track: 'FOUNDATION',
            content_source: 'AI_ENHANCED',
            coverage_percentage: 75,
          },
        },
        createdAt: new Date('2026-07-21T00:00:00.000Z'),
      }),
    };
    const modules = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'module-2',
          skillCanonical: 'react',
          displayName: 'React',
          rank: 2,
          estimatedMinutes: 120,
          feasibility: 'DEFERRED',
        },
        {
          id: 'module-1',
          skillCanonical: 'typescript',
          displayName: 'TypeScript',
          rank: 1,
          estimatedMinutes: 120,
          feasibility: 'FEASIBLE',
        },
      ]),
    };
    const sessions = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'session-2',
          moduleId: 'module-1',
          sequence: 2,
          title: 'TypeScript · Session 2',
          durationMinutes: 60,
          requiredTasks: [],
          scheduledStartAt: new Date('2026-07-20T12:00:00.000Z'),
        },
        {
          id: 'session-1',
          moduleId: 'module-1',
          sequence: 1,
          title: 'TypeScript · Session 1',
          durationMinutes: 60,
          requiredTasks: [],
          scheduledStartAt: new Date('2026-07-27T12:00:00.000Z'),
        },
      ]),
    };
    const progress = {
      find: jest.fn().mockResolvedValue([
        {
          sessionId: 'session-1',
          checkedChecklistItems: { __session: ['completed'] },
        },
      ]),
    };
    const service = new LearningRoadmapQueryService(
      roadmaps as unknown as Repository<LearningRoadmapEntity>,
      versions as never,
      modules as never,
      sessions as never,
      progress as never,
    );

    const result = await service.getActive('user-1', 'roadmap-1');

    expect(roadmaps.findOne).toHaveBeenCalledWith({
      where: { id: 'roadmap-1', userId: 'user-1', status: 'ACTIVE' },
    });
    expect(result.modules.map((module) => module.skill_canonical)).toEqual(['typescript', 'react']);
    expect(result.modules[0].sessions.map((session) => session.id)).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(result.modules[0].sessions.map((session) => session.status)).toEqual([
      'COMPLETED',
      'AVAILABLE',
    ]);
    expect(result.modules[1].sessions).toEqual([]);
    expect(result).toEqual(
      expect.objectContaining({
        learning_track: 'FOUNDATION',
        content_source: 'AI_ENHANCED',
        coverage_percentage: 75,
        projection: expect.objectContaining({
          total_units: 2,
          completed_units: 1,
          estimated_completion_date: '2026-07-27',
        }),
      }),
    );
    expect(progress.find).toHaveBeenCalledTimes(1);
  });

  it('does not expose an unowned or inactive roadmap', async () => {
    const service = new LearningRoadmapQueryService(
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.getActive('user-2', 'roadmap-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
