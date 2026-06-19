import { Injectable } from '@nestjs/common';
import type { GapItem } from '../gap-engine/gap-item';
import type { UnifiedDevelopmentPlanItem } from '../gap-report/unified-plan';
import { FeasibilityBudget, planFeasibility } from './feasibility-planner';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';
import {
  ComposedRoadmap,
  ComposedRoadmapStep,
  NotFeasibleItem,
  toFeasibilityInputs,
} from './roadmap-composer';

const LEARN_SOURCE_TYPES = ['course', 'official_doc', 'video', 'exercise', 'mini_project'] as const;

@Injectable()
export class RoadmapComposerService {
  constructor(private readonly matcher: LearningResourceMatcherService) {}

  compose(input: {
    learnItems: UnifiedDevelopmentPlanItem[];
    gapItems: GapItem[];
    budget: FeasibilityBudget;
  }): ComposedRoadmap {
    const feasibilityInputs = toFeasibilityInputs(input.learnItems, input.gapItems);
    const feasibilityBySkill = new Map(
      feasibilityInputs.map((item) => [item.skill_canonical, item] as const),
    );
    const plan = planFeasibility(feasibilityInputs, input.budget);

    const steps: ComposedRoadmapStep[] = [];
    const not_feasible_items: NotFeasibleItem[] = [];

    for (const item of plan.items) {
      if (item.verdict === 'not_feasible_before_deadline') {
        not_feasible_items.push({
          skill_canonical: item.skill_canonical,
          display_name: item.display_name,
          reason: 'ran_out_of_budget',
          fallback: 'crash_prep',
        });
        continue;
      }

      const feasibilityInput = feasibilityBySkill.get(item.skill_canonical);
      const matched = this.matcher.matchResources(
        [
          {
            skill_canonical_name: item.skill_canonical,
            required_level: feasibilityInput?.required_level ?? 3,
          },
        ],
        { sourceTypes: [...LEARN_SOURCE_TYPES] },
      );
      const resources = (matched.per_skill[0]?.resources ?? []).map((resource) => ({
        id: resource.id,
        source_type: resource.source_type,
        title: resource.title,
        url: resource.url,
        is_internal: resource.is_internal,
        outcome_type: resource.outcome_type,
        proof_of_completion: resource.proof_of_completion,
        match_score: resource.match_score,
        quality_score: resource.quality_score,
        freshness_score: resource.freshness_score,
      }));

      steps.push({
        skill_canonical: item.skill_canonical,
        display_name: item.display_name,
        strategy: item.strategy,
        estimated_hours: item.estimated_hours,
        priority: item.priority,
        resources,
      });
    }

    const ai_summary =
      steps.length === 0
        ? 'No learnable gaps fit the available time; focus on interview practice and honest CV framing.'
        : `Focus on ${steps.length} skill${steps.length > 1 ? 's' : ''} in ${plan.budget_hours}h; ${not_feasible_items.length} will not fit before the deadline.`;

    return { budget_hours: plan.budget_hours, steps, not_feasible_items, ai_summary };
  }
}
