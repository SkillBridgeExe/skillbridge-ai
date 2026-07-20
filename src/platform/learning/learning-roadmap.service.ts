import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { LearningRoadmapEntity } from '../../database/entities/learning-roadmap.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { DisplayTranslationService } from '../../modules/roadmap/display-translation.service';
import { TranslateDisplayRequestDto } from './dto/learning-roadmap.dto';

@Injectable()
export class LearningRoadmapPlatformService {
  constructor(
    @InjectRepository(LearningRoadmapEntity)
    private readonly roadmaps: Repository<LearningRoadmapEntity>,
    @InjectRepository(LearningSessionProgressEntity)
    private readonly progress: Repository<LearningSessionProgressEntity>,
    @Optional() private readonly displayTranslation?: DisplayTranslationService,
  ) {}

  async getActive(userId: string): Promise<LearningRoadmapEntity | null> {
    return this.roadmaps.findOne({ where: { userId, active: true } });
  }

  async clearActive(userId: string): Promise<{ deletedRoadmaps: number; deletedProgress: number }> {
    return this.roadmaps.manager.transaction(async (manager) => {
      const roadmapRepo = manager.getRepository(LearningRoadmapEntity);
      const progressRepo = manager.getRepository(LearningSessionProgressEntity);
      const activeRoadmap = await roadmapRepo.findOne({ where: { userId, active: true } });

      if (!activeRoadmap) {
        return { deletedRoadmaps: 0, deletedProgress: 0 };
      }

      const sessionIds = extractRoadmapSessionIds(activeRoadmap);
      const progressResult =
        sessionIds.length > 0
          ? await progressRepo.delete({ userId, sessionId: In(sessionIds) })
          : { affected: 0 };
      const roadmapResult = await roadmapRepo.delete({
        id: activeRoadmap.id,
        userId,
        active: true,
      });

      return {
        deletedRoadmaps: roadmapResult.affected ?? 0,
        deletedProgress: progressResult.affected ?? 0,
      };
    });
  }

  async patchSchedule(
    userId: string,
    roadmapId: string,
    schedule: unknown[],
  ): Promise<LearningRoadmapEntity> {
    const roadmap = await this.roadmaps.findOne({
      where: { id: roadmapId, userId, active: true },
    });
    if (!roadmap) throw new NotFoundException('Learning roadmap not found');
    roadmap.schedule = schedule;
    return this.roadmaps.save(roadmap);
  }

  async translateDisplayItems(dto: TranslateDisplayRequestDto): Promise<{
    items: Array<{
      id: string;
      translated_display: {
        locale: 'vi' | 'en';
        title?: string;
        description?: string;
        reason?: string;
        summary?: string;
      };
    }>;
  }> {
    const items = await Promise.all(
      dto.items.map(async (item) => ({
        id: item.id,
        translated_display: (await this.displayTranslation?.translateDisplay({
          locale: dto.locale,
          title: item.title,
          description: item.description,
          reason: item.reason,
          summary: item.summary,
        })) ?? {
          locale: dto.locale,
          title: item.title,
          description: item.description,
          reason: item.reason,
          summary: item.summary,
        },
      })),
    );

    return { items };
  }
}

function extractRoadmapSessionIds(roadmap: LearningRoadmapEntity): string[] {
  const ids = new Set<string>();
  collectSessionIds(roadmap.schedule, ids);
  const composed = roadmap.composedRoadmap as { sessions?: unknown } | null;
  collectSessionIds(composed?.sessions, ids);
  return [...ids];
}

function collectSessionIds(value: unknown, ids: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim()) ids.add(id);
  }
}
