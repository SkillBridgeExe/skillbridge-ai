import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LearningSessionProgressEntity } from '../../../database/entities/learning-session-progress.entity';
import {
  masteredSkillCanonicals,
  skillForSessionId,
} from '../../../platform/learning/mastered-skills';
import { ToolAdapter, ToolContext } from '../types';

export interface RoadmapProgressResult {
  tracked: boolean;
  skills: Array<{ skill: string; checked_items: number; mastered: boolean }>;
  mastered_count: number;
}

// Every number a tool returns is auto-licensed by the fabrication gate (including array lengths),
// so the payload stays small and shaped — same reasoning as github.enrich's 10-repo cap.
const MAX_SKILLS = 12;

/**
 * Reads the CURRENT user's own learning-roadmap progress for the chat tool loop. There is no
 * server-side "week": the roadmap is never persisted and weeks are an FE construct — the only
 * durable signal is learning_session_progress rows keyed `roadmap-<skill-slug>`, so this reports
 * per-skill checklist counts + mastered lessons and nothing it would have to invent.
 */
@Injectable()
export class RoadmapProgressAdapter implements ToolAdapter<
  Record<string, never>,
  RoadmapProgressResult
> {
  readonly name = 'roadmap.progress';

  constructor(
    // Optional: under NODE_ENV=test the ToolsModule registers no repos (no DataSource in e2e) —
    // same TracingService pattern; without a repo the tool reports honest-empty, never throws.
    @Optional()
    @InjectRepository(LearningSessionProgressEntity)
    private readonly progress?: Repository<LearningSessionProgressEntity>,
  ) {}

  argsSchema(_args: unknown): Record<string, never> {
    // No model-supplied arguments by design: the tool always reads ctx.userId's own rows —
    // zero injection surface, nothing to validate.
    return {};
  }

  async invoke(_args: Record<string, never>, ctx: ToolContext): Promise<RoadmapProgressResult> {
    if (!ctx.userId || !this.progress) return { tracked: false, skills: [], mastered_count: 0 };
    const rows = await this.progress.find({ where: { userId: ctx.userId } });
    const mastered = masteredSkillCanonicals(rows);
    const skills: RoadmapProgressResult['skills'] = [];
    for (const row of rows) {
      if (skills.length >= MAX_SKILLS) break;
      const skill = skillForSessionId(row.sessionId);
      if (!skill) continue;
      const checked = Object.values(row.checkedChecklistItems ?? {}).reduce(
        (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
        0,
      );
      skills.push({ skill, checked_items: checked, mastered: mastered.has(skill) });
    }
    return { tracked: skills.length > 0, skills, mastered_count: mastered.size };
  }
}
