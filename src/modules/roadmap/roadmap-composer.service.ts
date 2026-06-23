import { Injectable } from '@nestjs/common';
import type { GapItem } from '../gap-engine/gap-item';
import type { UnifiedDevelopmentPlanItem } from '../gap-report/unified-plan';
import type { ScoredCourse } from './course-matcher.service';
import { FeasibilityBudget, planFeasibility } from './feasibility-planner';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';
import type { LanguagePref, ScoredResource } from './learning-resource';
import {
  ComposedRoadmap,
  ComposedRoadmapStep,
  NotFeasibleItem,
  toFeasibilityInputs,
} from './roadmap-composer';
import { getSkillBridgeLessonContent } from './skillbridge-lesson-content';

const LEARN_SOURCE_TYPES = ['course', 'official_doc', 'video', 'exercise', 'mini_project'] as const;

@Injectable()
export class RoadmapComposerService {
  constructor(private readonly matcher: LearningResourceMatcherService) {}

  compose(input: {
    learnItems: UnifiedDevelopmentPlanItem[];
    gapItems: GapItem[];
    budget: FeasibilityBudget;
    languagePref?: LanguagePref;
  }): ComposedRoadmap {
    const feasibilityInputs = toFeasibilityInputs(input.learnItems, input.gapItems);
    const matchRequests = feasibilityInputs.map((item) => ({
      skill_canonical_name: item.skill_canonical,
      required_level: item.required_level,
    }));
    const matched = this.matcher.matchResources(matchRequests, {
      sourceTypes: [...LEARN_SOURCE_TYPES],
      langPref: input.languagePref ?? 'both',
    });
    const resourcesBySkill = new Map(
      matched.per_skill.map((item) => [item.skill_canonical_name, item.resources] as const),
    );
    const withResourceHours = feasibilityInputs.map((item) => ({
      ...item,
      resource_hours: primaryResourceHours(resourcesBySkill.get(item.skill_canonical) ?? []),
    }));
    const feasibilityBySkill = new Map(
      withResourceHours.map((item) => [item.skill_canonical, item] as const),
    );
    const plan = planFeasibility(withResourceHours, input.budget);

    const steps: ComposedRoadmapStep[] = [];
    const not_feasible_items: NotFeasibleItem[] = [];

    for (const item of plan.items) {
      if (item.verdict === 'not_feasible_before_deadline') {
        not_feasible_items.push({
          skill_canonical: item.skill_canonical,
          display_name: item.display_name,
          reason: 'ran_out_of_budget',
          fallback: fallbackFor(feasibilityBySkill.get(item.skill_canonical)),
        });
        continue;
      }

      const skillResources = resourcesBySkill.get(item.skill_canonical) ?? [];
      const resources = skillResources.map((resource) => ({
        id: resource.id,
        source_type: resource.source_type,
        title: resource.title,
        url: resource.url,
        is_internal: resource.is_internal,
        content_template_id: resource.content_template_id,
        description: resource.description,
        duration_minutes: resource.duration_minutes,
        outcome_type: resource.outcome_type,
        proof_of_completion: resource.proof_of_completion,
        match_score: resource.match_score,
        quality_score: resource.quality_score,
        freshness_score: resource.freshness_score,
        low_confidence: resource.low_confidence,
      }));

      steps.push({
        skill_canonical: item.skill_canonical,
        display_name: item.display_name,
        strategy: item.strategy,
        estimated_hours: item.estimated_hours,
        priority: item.priority,
        resources,
        recommended_courses: skillResources
          .filter((resource) => resource.source_type === 'course')
          .map(toRecommendedCourse),
        lesson_content: getSkillBridgeLessonContent(
          item.skill_canonical,
          skillResources.map((resource) => resource.id),
        ),
      });
    }

    const ai_summary =
      steps.length === 0
        ? 'No learnable gaps fit the available time; focus on interview practice and honest CV framing.'
        : `Focus on ${steps.length} skill${steps.length > 1 ? 's' : ''} in ${plan.budget_hours}h; ${not_feasible_items.length} will not fit before the deadline.`;

    return { budget_hours: plan.budget_hours, steps, not_feasible_items, ai_summary };
  }
}

function primaryResourceHours(resources: ScoredResource[]): number | null {
  const primaryMinutes = resources[0]?.duration_minutes;
  return Number.isFinite(primaryMinutes) && primaryMinutes > 0 ? primaryMinutes / 60 : null;
}

function fallbackFor(
  item: ReturnType<typeof toFeasibilityInputs>[number] | undefined,
): NotFeasibleItem['fallback'] {
  if (item?.interview_confirmed) return 'interview_practice';
  if (item?.needs_evidence) return 'cv_fix';
  return 'crash_prep';
}

function toRecommendedCourse(resource: ScoredResource): ScoredCourse {
  return {
    id: resource.id,
    title: resource.title,
    url: resource.url ?? '',
    provider: resource.provider,
    language: resource.language,
    duration_minutes: resource.duration_minutes,
    rating: resource.quality_score / 20,
    is_free: resource.is_free,
    difficulty: resource.difficulty,
    skills: resource.skills,
    match_score: resource.match_score,
    match_breakdown: {
      rating_pts: resource.match_breakdown.quality_pts,
      language_pts: resource.match_breakdown.language_pts,
      free_pts: resource.match_breakdown.free_pts,
      level_fit_pts: resource.match_breakdown.level_fit_pts,
      multi_skill_pts: resource.match_breakdown.multi_skill_pts,
    },
  };
}
