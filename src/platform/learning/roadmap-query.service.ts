import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { LearningModuleEntity } from '../../database/entities/learning-module.entity';
import { LearningRoadmapEntity } from '../../database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../database/entities/learning-roadmap-version.entity';
import { LearningSessionEntity } from '../../database/entities/learning-session.entity';

export interface ActiveLearningRoadmapResponse {
  id: string;
  intent: LearningRoadmapEntity['intent'];
  status: 'ACTIVE';
  revision: number;
  target_role: string | null;
  target_level: string | null;
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
    sessions: Array<{
      id: string;
      sequence: number;
      title: string;
      scheduled_start_at: string;
      duration_minutes: number;
      required_tasks: Array<Record<string, unknown>>;
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
            order: { scheduledStartAt: 'ASC', sequence: 'ASC' },
          });
    const sessionsByModule = new Map<string, LearningSessionEntity[]>();
    for (const session of sessions) {
      const rows = sessionsByModule.get(session.moduleId) ?? [];
      rows.push(session);
      sessionsByModule.set(session.moduleId, rows);
    }
    return {
      id: roadmap.id,
      intent: roadmap.intent,
      status: 'ACTIVE',
      revision: roadmap.revision,
      target_role: roadmap.targetRole ?? roadmap.draftConfig.source_target_role ?? null,
      target_level: roadmap.targetLevel ?? null,
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
          sessions: (sessionsByModule.get(module.id) ?? [])
            .sort(
              (a, b) =>
                a.scheduledStartAt.getTime() - b.scheduledStartAt.getTime() ||
                a.sequence - b.sequence,
            )
            .map((session) => ({
              id: session.id,
              sequence: session.sequence,
              title: session.title,
              scheduled_start_at: session.scheduledStartAt.toISOString(),
              duration_minutes: session.durationMinutes,
              required_tasks: session.requiredTasks,
            })),
        })),
    };
  }
}
