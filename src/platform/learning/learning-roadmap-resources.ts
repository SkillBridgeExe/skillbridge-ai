import { BadRequestException } from '@nestjs/common';
import type { LearningCandidateSkill } from '../../database/entities/learning-roadmap.entity';
import type { GapItem } from '../../modules/gap-engine/gap-item';
import type { UnifiedDevelopmentPlanItem } from '../../modules/gap-report/unified-plan';
import type { ComposedRoadmap } from '../../modules/roadmap/roadmap-composer';
import { RoadmapComposerService } from '../../modules/roadmap/roadmap-composer.service';

export type LearningResourceSelection = Record<string, string[]>;

export function composeLearningCandidates(
  composer: RoadmapComposerService,
  candidates: LearningCandidateSkill[],
  languagePref: 'vi' | 'en' | 'both',
): ComposedRoadmap {
  const { learnItems, gapItems } = toComposerInputs(candidates);
  return composer.compose({
    learnItems,
    gapItems,
    budget: { available_days: 365, hours_per_week: 168 },
    languagePref,
  });
}

export function assertValidResourceSelection(
  candidates: LearningCandidateSkill[],
  composed: ComposedRoadmap,
  selection: LearningResourceSelection,
): void {
  const candidateSkills = new Set(candidates.map((candidate) => candidate.skill_canonical));
  const allowedBySkill = new Map(
    composed.steps.map((step) => [
      step.skill_canonical,
      new Set(step.resources.map((resource) => resource.id)),
    ]),
  );

  for (const [skillCanonical, resourceIds] of Object.entries(selection)) {
    if (!candidateSkills.has(skillCanonical)) {
      throw new BadRequestException(`Skill '${skillCanonical}' is not a roadmap candidate.`);
    }
    if (!Array.isArray(resourceIds) || resourceIds.length > 30) {
      throw new BadRequestException(
        `Resource selection for skill '${skillCanonical}' must contain at most 30 ids.`,
      );
    }
    const seen = new Set<string>();
    const allowed = allowedBySkill.get(skillCanonical) ?? new Set<string>();
    for (const resourceId of resourceIds) {
      if (typeof resourceId !== 'string' || !resourceId.trim()) {
        throw new BadRequestException(
          `Resource ids for skill '${skillCanonical}' must be strings.`,
        );
      }
      if (seen.has(resourceId)) {
        throw new BadRequestException(
          `Resource '${resourceId}' is selected more than once for skill '${skillCanonical}'.`,
        );
      }
      if (!allowed.has(resourceId)) {
        throw new BadRequestException(
          `Resource '${resourceId}' is not available for skill '${skillCanonical}'.`,
        );
      }
      seen.add(resourceId);
    }
  }
}

export function applyResourceSelection(
  composed: ComposedRoadmap,
  selection: LearningResourceSelection | undefined,
): ComposedRoadmap {
  if (!selection) return composed;
  return {
    ...composed,
    steps: composed.steps.map((step) => {
      const selectedIds = selection[step.skill_canonical];
      if (!selectedIds) return step;
      const selected = new Set(selectedIds);
      const resources = step.resources.filter((resource) => selected.has(resource.id));
      const lessonContent = step.lesson_content
        ? {
            ...step.lesson_content,
            source_resource_ids: (step.lesson_content.source_resource_ids ?? []).filter((id) =>
              selected.has(id),
            ),
          }
        : undefined;
      return {
        ...step,
        resources,
        recommended_courses: step.recommended_courses?.filter((course) => selected.has(course.id)),
        lesson_content: lessonContent,
      };
    }),
  };
}

function toComposerInputs(candidates: LearningCandidateSkill[]): {
  learnItems: UnifiedDevelopmentPlanItem[];
  gapItems: GapItem[];
} {
  return {
    learnItems: candidates.map((candidate) => ({
      source: 'gap',
      track: 'learn',
      skill_canonical: candidate.skill_canonical,
      display_name: candidate.display_name,
      priority: candidate.system_priority,
      severity: candidate.system_priority,
      rationale: candidate.rationale,
      requirement_id: `learning:${candidate.skill_canonical}`,
    })),
    gapItems: candidates.map((candidate) => ({
      requirement_id: `learning:${candidate.skill_canonical}`,
      source: 'role_rubric',
      type: 'hard_skill',
      canonical_name: candidate.skill_canonical,
      display_name: candidate.display_name,
      importance: 'REQUIRED',
      cv_status: 'missing',
      cv_level: 0,
      required_level: 3,
      gap_levels: 3,
      satisfied_by: null,
      evidence_refs: [],
      evidence_risk: 'none',
      fixability: 'learn',
      market_demand: null,
      severity: candidate.system_priority,
      confidence: 1,
      recommended_next_action: candidate.rationale,
    })),
  };
}
