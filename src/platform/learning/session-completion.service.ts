import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { LearningModuleEntity } from '../../database/entities/learning-module.entity';
import { LearningRoadmapEntity } from '../../database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../database/entities/learning-roadmap-version.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { LearningSessionEntity } from '../../database/entities/learning-session.entity';
import {
  isLearningSessionMarkedComplete,
  resolveModuleSessionStatuses,
  validateLearningSessionCompletion,
} from './learning-session-state';

export interface LearningSessionCompletionResponse {
  session_id: string;
  status: 'COMPLETED';
  module_completed: boolean;
  next_session_id: string | null;
  unlocked_session_ids: string[];
}

@Injectable()
export class LearningSessionCompletionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async complete(userId: string, sessionId: string): Promise<LearningSessionCompletionResponse> {
    return this.dataSource.transaction(async (manager) => {
      const sessionRepo = manager.getRepository(LearningSessionEntity);
      const moduleRepo = manager.getRepository(LearningModuleEntity);
      const versionRepo = manager.getRepository(LearningRoadmapVersionEntity);
      const roadmapRepo = manager.getRepository(LearningRoadmapEntity);
      const progressRepo = manager.getRepository(LearningSessionProgressEntity);

      const targetSession = await sessionRepo.findOne({ where: { id: sessionId } });
      if (!targetSession) throw sessionNotFound(sessionId);
      const targetModule = await moduleRepo.findOne({
        where: { id: targetSession.moduleId },
      });
      if (!targetModule) throw sessionNotFound(sessionId);
      const version = await versionRepo.findOne({
        where: { id: targetModule.versionId },
      });
      if (!version) throw sessionNotFound(sessionId);
      const roadmap = await roadmapRepo.findOne({
        where: {
          id: version.roadmapId,
          userId,
          status: 'ACTIVE',
          activeVersionId: version.id,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!roadmap) throw sessionNotFound(sessionId);

      const modules = await moduleRepo.find({
        where: { versionId: version.id },
        order: { rank: 'ASC' },
      });
      const moduleIds = modules.map((module) => module.id);
      const sessions =
        moduleIds.length === 0
          ? []
          : await sessionRepo.find({
              where: { moduleId: In(moduleIds) },
              order: { sequence: 'ASC' },
            });
      const sessionIds = sessions.map((session) => session.id);
      const progressRows =
        sessionIds.length === 0
          ? []
          : await progressRepo.find({
              where: { userId, sessionId: In(sessionIds) },
            });
      const completedBefore = completedSessionIds(progressRows);
      const statusesBefore = resolveModuleSessionStatuses(modules, sessions, completedBefore);
      const targetStatus = statusesBefore.get(sessionId);
      if (!targetStatus) throw sessionNotFound(sessionId);

      if (targetStatus !== 'COMPLETED') {
        const existing =
          progressRows.find((row) => row.sessionId === sessionId) ??
          progressRepo.create({
            userId,
            sessionId,
            learningSessionId: sessionId,
            revision: 0,
            checkedChecklistItems: {},
            exerciseProofs: {},
            quizAttempts: {},
          });
        const validation = validateLearningSessionCompletion(targetSession.requiredTasks, {
          checkedChecklistItems: existing.checkedChecklistItems ?? {},
          exerciseProofs: existing.exerciseProofs ?? {},
        });
        if (!validation.complete) {
          throw new UnprocessableEntityException({
            message: 'Complete the required learning tasks before finishing this session.',
            errors: {
              missing_section_ids: validation.missing_section_ids,
              missing_checklist_item_ids: validation.missing_checklist_item_ids,
              missing_exercise_ids: validation.missing_exercise_ids,
            },
          });
        }

        existing.checkedChecklistItems = {
          ...(existing.checkedChecklistItems ?? {}),
          __session: ['completed'],
        };
        existing.learningSessionId = sessionId;
        existing.revision = (existing.revision ?? 0) + 1;
        const saved = await progressRepo.save(existing);
        const existingIndex = progressRows.findIndex((row) => row.sessionId === sessionId);
        if (existingIndex >= 0) progressRows[existingIndex] = saved;
        else progressRows.push(saved);
      }

      const completedAfter = completedSessionIds(progressRows);
      const statusesAfter = resolveModuleSessionStatuses(modules, sessions, completedAfter);
      const targetModuleSessions = sessions.filter(
        (session) => session.moduleId === targetModule.id,
      );
      const moduleCompleted = targetModuleSessions.every((session) =>
        completedAfter.has(session.id),
      );
      const orderedSessions = orderSessions(modules, sessions);
      const targetIndex = orderedSessions.findIndex((session) => session.id === sessionId);
      const nextSession =
        orderedSessions
          .slice(targetIndex + 1)
          .find((session) => statusesAfter.get(session.id) === 'AVAILABLE') ??
        orderedSessions.find((session) => statusesAfter.get(session.id) === 'AVAILABLE');
      return {
        session_id: sessionId,
        status: 'COMPLETED',
        module_completed: moduleCompleted,
        next_session_id: nextSession?.id ?? null,
        unlocked_session_ids: [],
      };
    });
  }
}

function completedSessionIds(progressRows: LearningSessionProgressEntity[]): Set<string> {
  return new Set(
    progressRows
      .filter((row) => isLearningSessionMarkedComplete(row.checkedChecklistItems))
      .map((row) => row.sessionId),
  );
}

function orderSessions(
  modules: LearningModuleEntity[],
  sessions: LearningSessionEntity[],
): LearningSessionEntity[] {
  const moduleRank = new Map(modules.map((module) => [module.id, module.rank]));
  return [...sessions].sort(
    (left, right) =>
      (moduleRank.get(left.moduleId) ?? Number.MAX_SAFE_INTEGER) -
        (moduleRank.get(right.moduleId) ?? Number.MAX_SAFE_INTEGER) ||
      left.sequence - right.sequence,
  );
}

function sessionNotFound(sessionId: string): NotFoundException {
  return new NotFoundException(`Learning session '${sessionId}' was not found.`);
}
