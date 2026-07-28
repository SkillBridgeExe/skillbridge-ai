import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { LearningModuleEntity } from '../../database/entities/learning-module.entity';
import { LearningRoadmapEntity } from '../../database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../database/entities/learning-roadmap-version.entity';
import { LearningSessionEntity } from '../../database/entities/learning-session.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import {
  isLearningSessionMarkedComplete,
  resolveModuleSessionStatuses,
  type LearningRuntimeSessionStatus,
} from './learning-session-state';
import {
  computeLearningProjection,
  type LearningProjection,
  todayInLearningTimezone,
} from './learning-projection';
import type { LearningRoadmapCadenceDraft } from '../../database/entities/learning-roadmap.entity';

export interface ActiveLearningRoadmapResponse {
  id: string;
  intent: LearningRoadmapEntity['intent'];
  status: 'ACTIVE';
  revision: number;
  target_role: string | null;
  target_level: string | null;
  learning_track: 'FAST_TRACK' | 'FOUNDATION';
  content_source: 'DETERMINISTIC' | 'AI_ENHANCED' | 'DETERMINISTIC_FALLBACK';
  coverage_percentage: number;
  projection: LearningProjection;
  version: {
    id: string;
    version_no: number;
    resource_catalog_version: string;
    content_version: string;
    created_at: string;
  };
  modules: Array<{
    id: string;
    skill_canonical: string;
    display_name: string;
    rank: number;
    estimated_minutes: number;
    feasibility: LearningModuleEntity['feasibility'];
    prerequisite_warnings: string[];
    sessions: Array<{
      id: string;
      sequence: number;
      title: string;
      scheduled_start_at: string;
      duration_minutes: number;
      required_tasks: Array<Record<string, unknown>>;
      status: LearningRuntimeSessionStatus;
    }>;
  }>;
}

@Injectable()
export class LearningRoadmapQueryService {
  constructor(
    @InjectRepository(LearningRoadmapEntity)
    private readonly roadmaps: Repository<LearningRoadmapEntity>,
    @InjectRepository(LearningRoadmapVersionEntity)
    private readonly versions: Repository<LearningRoadmapVersionEntity>,
    @InjectRepository(LearningModuleEntity)
    private readonly modules: Repository<LearningModuleEntity>,
    @InjectRepository(LearningSessionEntity)
    private readonly sessions: Repository<LearningSessionEntity>,
    @InjectRepository(LearningSessionProgressEntity)
    private readonly progress: Repository<LearningSessionProgressEntity>,
  ) {}

  async archiveActive(userId: string): Promise<{ archived: number }> {
    const result = await this.roadmaps.update({ userId, status: 'ACTIVE' }, { status: 'ARCHIVED' });
    return { archived: result.affected ?? 0 };
  }

  async getActive(userId: string, roadmapId: string): Promise<ActiveLearningRoadmapResponse> {
    const roadmap = await this.roadmaps.findOne({
      where: { id: roadmapId, userId, status: 'ACTIVE' },
    });
    if (!roadmap?.activeVersionId) {
      throw new NotFoundException(`Active learning roadmap '${roadmapId}' was not found.`);
    }
    const version = await this.versions.findOne({
      where: { id: roadmap.activeVersionId, roadmapId: roadmap.id },
    });
    if (!version) {
      throw new NotFoundException(`Active version for roadmap '${roadmapId}' was not found.`);
    }
    const modules = await this.modules.find({
      where: { versionId: version.id },
      order: { rank: 'ASC' },
    });
    const moduleIds = modules.map((module) => module.id);
    const sessions =
      moduleIds.length === 0
        ? []
        : await this.sessions.find({
            where: { moduleId: In(moduleIds) },
            order: { sequence: 'ASC', scheduledStartAt: 'ASC' },
          });
    const sessionsByModule = new Map<string, LearningSessionEntity[]>();
    for (const session of sessions) {
      const rows = sessionsByModule.get(session.moduleId) ?? [];
      rows.push(session);
      sessionsByModule.set(session.moduleId, rows);
    }
    const sessionIds = sessions.map((session) => session.id);
    const progressRows =
      sessionIds.length === 0
        ? []
        : await this.progress.find({
            where: { userId, sessionId: In(sessionIds) },
          });
    const completedSessionIds = new Set(
      progressRows
        .filter((row) => isLearningSessionMarkedComplete(row.checkedChecklistItems))
        .map((row) => row.sessionId),
    );
    const statuses = resolveModuleSessionStatuses(modules, sessions, completedSessionIds);
    const generatedPlan = asGeneratedPlan(version.inputSnapshot?.generated_plan);
    const cadence = resolveCadence(roadmap, version.inputSnapshot, sessions);
    const projection = computeLearningProjection({
      cadence,
      sessions,
      completedSessionIds,
      today: todayInLearningTimezone(cadence.timezone),
    });
    return {
      id: roadmap.id,
      intent: roadmap.intent,
      status: 'ACTIVE',
      revision: roadmap.revision,
      target_role: roadmap.targetRole ?? roadmap.draftConfig.source_target_role ?? null,
      target_level: roadmap.targetLevel ?? null,
      learning_track:
        generatedPlan.learning_track ??
        (roadmap.intent === 'JD_APPLICATION' ? 'FAST_TRACK' : 'FOUNDATION'),
      content_source: generatedPlan.content_source ?? 'DETERMINISTIC',
      coverage_percentage: generatedPlan.coverage_percentage ?? 100,
      projection,
      version: {
        id: version.id,
        version_no: version.versionNo,
        resource_catalog_version: version.resourceCatalogVersion,
        content_version: version.contentVersion,
        created_at: version.createdAt.toISOString(),
      },
      modules: [...modules]
        .sort((a, b) => a.rank - b.rank)
        .map((module) => ({
          id: module.id,
          skill_canonical: module.skillCanonical,
          display_name: module.displayName,
          rank: module.rank,
          estimated_minutes: module.estimatedMinutes,
          feasibility: module.feasibility,
          prerequisite_warnings: module.prerequisiteCanonicals,
          sessions: (sessionsByModule.get(module.id) ?? [])
            .sort(
              (a, b) =>
                a.sequence - b.sequence ||
                a.scheduledStartAt.getTime() - b.scheduledStartAt.getTime(),
            )
            .map((session) => ({
              id: session.id,
              sequence: session.sequence,
              title: session.title,
              scheduled_start_at: session.scheduledStartAt.toISOString(),
              duration_minutes: session.durationMinutes,
              required_tasks: session.requiredTasks,
              status: statuses.get(session.id) ?? 'AVAILABLE',
            })),
        })),
    };
  }
}

function resolveCadence(
  roadmap: LearningRoadmapEntity,
  inputSnapshot: Record<string, unknown>,
  sessions: LearningSessionEntity[],
): LearningRoadmapCadenceDraft {
  const current = asCadence(roadmap.draftConfig.cadence);
  if (current) return current;
  const snapshotted = asCadence(inputSnapshot?.cadence);
  if (snapshotted) return snapshotted;

  const schedule = roadmap.draftConfig.schedule;
  const firstDate = sessions
    .map((session) => session.scheduledStartAt)
    .sort((left, right) => left.getTime() - right.getTime())
    .at(0)
    ?.toISOString()
    .slice(0, 10);
  const studyDays = schedule
    ? Math.min(7, Math.max(1, new Set(schedule.slots.map((slot) => slot.iso_weekday)).size))
    : 1;
  return {
    timezone: schedule?.timezone ?? 'Asia/Ho_Chi_Minh',
    start_date: firstDate ?? new Date().toISOString().slice(0, 10),
    study_days_per_week: studyDays as LearningRoadmapCadenceDraft['study_days_per_week'],
    session_minutes: schedule?.session_minutes ?? 60,
  };
}

function asCadence(value: unknown): LearningRoadmapCadenceDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.timezone !== 'string' ||
    typeof row.start_date !== 'string' ||
    !Number.isInteger(row.study_days_per_week) ||
    Number(row.study_days_per_week) < 1 ||
    Number(row.study_days_per_week) > 7 ||
    ![30, 45, 60, 90].includes(Number(row.session_minutes))
  ) {
    return undefined;
  }
  return {
    timezone: row.timezone,
    start_date: row.start_date,
    study_days_per_week:
      row.study_days_per_week as LearningRoadmapCadenceDraft['study_days_per_week'],
    session_minutes: row.session_minutes as LearningRoadmapCadenceDraft['session_minutes'],
  };
}

function asGeneratedPlan(value: unknown): {
  learning_track?: 'FAST_TRACK' | 'FOUNDATION';
  content_source?: 'DETERMINISTIC' | 'AI_ENHANCED' | 'DETERMINISTIC_FALLBACK';
  coverage_percentage?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const learningTrack =
    row.learning_track === 'FAST_TRACK' || row.learning_track === 'FOUNDATION'
      ? row.learning_track
      : undefined;
  const contentSource =
    row.content_source === 'DETERMINISTIC' ||
    row.content_source === 'AI_ENHANCED' ||
    row.content_source === 'DETERMINISTIC_FALLBACK'
      ? row.content_source
      : undefined;
  const coverage =
    typeof row.coverage_percentage === 'number' && Number.isFinite(row.coverage_percentage)
      ? Math.max(0, Math.min(100, Math.round(row.coverage_percentage)))
      : undefined;
  return {
    ...(learningTrack ? { learning_track: learningTrack } : {}),
    ...(contentSource ? { content_source: contentSource } : {}),
    ...(coverage !== undefined ? { coverage_percentage: coverage } : {}),
  };
}
