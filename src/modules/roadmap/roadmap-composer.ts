import type { GapItem } from '../gap-engine/gap-item';
import type { UnifiedDevelopmentPlanItem } from '../gap-report/unified-plan';
import type { ScoredCourse } from './course-matcher.service';
import type { FeasibilityGapInput, FeasibilityStrategy } from './feasibility-planner';
import type { ScoredResource } from './learning-resource';
import type { SkillBridgeLessonContent } from './skillbridge-lesson-content';

const DEFAULT_REQUIRED_LEVEL = 3;
const DEFAULT_CV_LEVEL = 0;

export function toFeasibilityInputs(
  learnItems: UnifiedDevelopmentPlanItem[],
  gapItems: GapItem[],
): FeasibilityGapInput[] {
  const byCanonical = new Map<string, GapItem>();
  const byRequirement = new Map<string, GapItem>();

  for (const gap of gapItems) {
    if (gap.canonical_name) byCanonical.set(gap.canonical_name.toLowerCase(), gap);
    if (gap.requirement_id) byRequirement.set(gap.requirement_id, gap);
  }

  return learnItems.map((item) => {
    const gap =
      (item.skill_canonical ? byCanonical.get(item.skill_canonical.toLowerCase()) : undefined) ??
      (item.requirement_id ? byRequirement.get(item.requirement_id) : undefined) ??
      null;

    return {
      skill_canonical: item.skill_canonical ?? item.display_name,
      display_name: item.display_name,
      severity: item.severity,
      importance: gap?.importance ?? 'REQUIRED',
      required_level: gap?.required_level ?? DEFAULT_REQUIRED_LEVEL,
      cv_level: gap?.cv_level ?? DEFAULT_CV_LEVEL,
      market_demand: gap?.market_demand ?? null,
      needs_evidence: gap ? gap.evidence_risk !== 'none' : false,
      interview_confirmed: item.source === 'both' || item.source === 'interview',
      resource_hours: null,
    };
  });
}

export interface ComposedRoadmapStep {
  skill_canonical: string;
  display_name: string;
  strategy: FeasibilityStrategy;
  estimated_hours: number;
  priority: number;
  resources: Array<
    Pick<
      ScoredResource,
      | 'id'
      | 'source_type'
      | 'title'
      | 'url'
      | 'is_internal'
      | 'content_template_id'
      | 'description'
      | 'duration_minutes'
      | 'outcome_type'
      | 'proof_of_completion'
      | 'match_score'
      | 'quality_score'
      | 'freshness_score'
      | 'low_confidence'
    >
  >;
  recommended_courses?: ScoredCourse[];
  lesson_content?: SkillBridgeLessonContent;
}

export interface NotFeasibleItem {
  skill_canonical: string;
  display_name: string;
  reason: 'ran_out_of_budget';
  fallback: 'crash_prep' | 'interview_practice' | 'cv_fix';
}

export interface ComposedRoadmap {
  budget_hours: number;
  steps: ComposedRoadmapStep[];
  not_feasible_items: NotFeasibleItem[];
  ai_summary: string;
  no_learning_gaps?: boolean;
}
