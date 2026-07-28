import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { LearningModuleEntity } from '../../database/entities/learning-module.entity';
import {
  LearningRoadmapCadenceDraft,
  LearningRoadmapEntity,
} from '../../database/entities/learning-roadmap.entity';
import { LearningSessionEntity } from '../../database/entities/learning-session.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { RescheduleLearningRoadmapDto } from './dto/roadmap.dto';
import { projectCadenceDates } from './learning-cadence';
import { isLearningSessionMarkedComplete } from './learning-session-state';
import {
  ActiveLearningRoadmapResponse,
  LearningRoadmapQueryService,
} from './roadmap-query.service';

@Injectable()
export class LearningRoadmapRescheduleService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queries: LearningRoadmapQueryService,
  ) {}

  async reschedule(
    userId: string,
    roadmapId: string,
    dto: RescheduleLearningRoadmapDto,
  ): Promise<ActiveLearningRoadmapResponse> {
    await this.dataSource.transaction(async (manager) => {
      const roadmap = await manager.findOne(LearningRoadmapEntity, {
        where: { id: roadmapId, userId, status: 'ACTIVE' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!roadmap?.activeVersionId) {
        throw new NotFoundException(`Active learning roadmap '${roadmapId}' was not found.`);
      }
      if (roadmap.revision !== dto.expected_revision) {
        throw new ConflictException('Learning roadmap has changed; reload before rescheduling.');
      }

      const modules = await manager.find(LearningModuleEntity, {
        where: { versionId: roadmap.activeVersionId },
        order: { rank: 'ASC' },
      });
      const moduleIds = modules.map((module) => module.id);
      const sessions =
        moduleIds.length === 0
          ? []
          : await manager.find(LearningSessionEntity, {
              where: { moduleId: In(moduleIds) },
            });
      const progressRows =
        sessions.length === 0
          ? []
          : await manager.find(LearningSessionProgressEntity, {
              where: { userId, sessionId: In(sessions.map((session) => session.id)) },
            });
      const completedSessionIds = new Set(
        progressRows
          .filter((row) => isLearningSessionMarkedComplete(row.checkedChecklistItems))
          .map((row) => row.sessionId),
      );
      const moduleRank = new Map(modules.map((module) => [module.id, module.rank]));
      const pendingSessions = sessions
        .filter((session) => !completedSessionIds.has(session.id))
        .sort(
          (left, right) =>
            (moduleRank.get(left.moduleId) ?? Number.MAX_SAFE_INTEGER) -
              (moduleRank.get(right.moduleId) ?? Number.MAX_SAFE_INTEGER) ||
            left.sequence - right.sequence,
        );
      const cadence = nextCadence(roadmap, dto);
      const projectedDates = projectCadenceDates({
        timezone: cadence.timezone,
        startDate: cadence.start_date,
        studyDaysPerWeek: cadence.study_days_per_week,
        count: pendingSessions.length,
      });

      for (let index = 0; index < pendingSessions.length; index += 1) {
        await manager.update(
          LearningSessionEntity,
          { id: pendingSessions[index].id },
          { scheduledStartAt: projectedDates[index] },
        );
      }
      const nextConfig = { ...roadmap.draftConfig, cadence };
      const updated = await manager.update(
        LearningRoadmapEntity,
        { id: roadmapId, userId, status: 'ACTIVE', revision: dto.expected_revision },
        { draftConfig: nextConfig, revision: dto.expected_revision + 1 },
      );
      if (updated.affected !== 1) {
        throw new ConflictException('Learning roadmap changed while rescheduling.');
      }
    });

    return this.queries.getActive(userId, roadmapId);
  }
}

function nextCadence(
  roadmap: LearningRoadmapEntity,
  dto: RescheduleLearningRoadmapDto,
): LearningRoadmapCadenceDraft {
  const previous = roadmap.draftConfig.cadence;
  const legacy = roadmap.draftConfig.schedule;
  return {
    timezone: previous?.timezone ?? legacy?.timezone ?? 'Asia/Ho_Chi_Minh',
    start_date: dto.start_date,
    study_days_per_week: dto.study_days_per_week,
    session_minutes:
      dto.session_minutes ?? previous?.session_minutes ?? legacy?.session_minutes ?? 60,
  };
}
