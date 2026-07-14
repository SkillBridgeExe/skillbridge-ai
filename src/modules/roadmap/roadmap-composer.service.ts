import { Injectable, Optional } from '@nestjs/common';
import type { GapItem } from '../gap-engine/gap-item';
import type { UnifiedDevelopmentPlanItem } from '../gap-report/unified-plan';
import type { ScoredCourse } from './course-matcher.service';
import { FeasibilityBudget, planFeasibility } from './feasibility-planner';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';
import { scoreResource, type LanguagePref, type ScoredResource } from './learning-resource';
import {
  ComposedRoadmap,
  ComposedRoadmapStep,
  RoadmapSourceRef,
  toFeasibilityInputs,
} from './roadmap-composer';
import { planRoadmapSchedule } from './schedule-planner';
import { getSkillBridgeLessonContent } from './skillbridge-lesson-content';
import { DisplayTranslationService } from './display-translation.service';

const LEARN_SOURCE_TYPES = ['course', 'official_doc', 'video', 'exercise', 'mini_project'] as const;
const MAX_RESOURCES_PER_STEP = 30;
const MAX_RECOMMENDED_COURSES_PER_STEP = 30;

@Injectable()
export class RoadmapComposerService {
  constructor(
    private readonly matcher: LearningResourceMatcherService,
    @Optional() private readonly displayTranslation?: DisplayTranslationService,
  ) {}

  previewResourceOptions(
    skills: Array<{ skill_canonical: string; required_level?: number | null }>,
    languagePref: LanguagePref = 'both',
  ): Map<
    string,
    Array<
      Pick<
        ScoredResource,
        | 'id'
        | 'source_type'
        | 'title'
        | 'url'
        | 'is_internal'
        | 'description'
        | 'duration_minutes'
        | 'outcome_type'
      >
    >
  > {
    const requests = skills.map((skill) => ({
      skill_canonical_name: skill.skill_canonical,
      required_level: skill.required_level ?? 3,
    }));
    const matched = this.matcher.matchResources(requests, {
      sourceTypes: [...LEARN_SOURCE_TYPES],
      langPref: languagePref,
      preferLanguageIfAvailable: languagePref !== 'both',
    });

    return new Map(
      matched.per_skill.map((item) => [
        item.skill_canonical_name,
        keepOnePrimaryVideo(item.resources)
          .slice(0, MAX_RESOURCES_PER_STEP)
          .map((resource) => ({
            id: resource.id,
            source_type: resource.source_type,
            title: resource.title,
            url: resource.url,
            is_internal: resource.is_internal,
            description: resource.description,
            duration_minutes: resource.duration_minutes,
            outcome_type: resource.outcome_type,
          })),
      ]),
    );
  }

  async compose(input: {
    learnItems: UnifiedDevelopmentPlanItem[];
    gapItems: GapItem[];
    budget: FeasibilityBudget;
    languagePref?: LanguagePref;
    selectedSkillOrder?: string[];
    excludedSkills?: string[];
    selectedResources?: Record<string, string[]>;
    sourceRefs?: RoadmapSourceRef[];
    translateDisplay?: boolean;
  }): Promise<ComposedRoadmap> {
    const learnItems = applySkillSelection(input.learnItems, {
      selectedSkillOrder: input.selectedSkillOrder,
      excludedSkills: input.excludedSkills,
    });
    const feasibilityInputs = toFeasibilityInputs(learnItems, input.gapItems);
    const matchRequests = feasibilityInputs.map((item) => ({
      skill_canonical_name: item.skill_canonical,
      required_level: item.required_level,
    }));
    const matched = this.matcher.matchResources(matchRequests, {
      sourceTypes: [...LEARN_SOURCE_TYPES],
      langPref: input.languagePref ?? 'both',
      preferLanguageIfAvailable: (input.languagePref ?? 'both') !== 'both',
    });
    const resourcesBySkill = new Map(
      matched.per_skill.map(
        (item) => [item.skill_canonical_name, [...item.resources]] as [string, ScoredResource[]],
      ),
    );
    const withResourceHours = feasibilityInputs.map((item) => ({
      ...item,
      resource_hours: primaryResourceHours(resourcesBySkill.get(item.skill_canonical) ?? []),
    }));
    const plan = planFeasibility(withResourceHours, input.budget);
    const planItems = orderBySelectedSkill(plan.items, input.selectedSkillOrder);

    const steps: ComposedRoadmapStep[] = [];

    for (const item of planItems) {
      const skillResources = resourcesBySkill.get(item.skill_canonical) ?? [];
      const hasVideo = skillResources.some((r) => r.source_type === 'video');
      if (!hasVideo && typeof this.matcher.allResources === 'function') {
        const videoCandidate = this.matcher
          .allResources()
          .find(
            (r) =>
              r.source_type === 'video' &&
              r.validation_status === 'verified' &&
              r.skills.some((s) => s.skill_canonical_name === item.skill_canonical),
          );
        if (videoCandidate) {
          const teachesLevel =
            videoCandidate.skills.find((s) => s.skill_canonical_name === item.skill_canonical)
              ?.teaches_level ?? 3;

          const requestedSet = new Set(matchRequests.map((r) => r.skill_canonical_name));
          const req = matchRequests.find(
            (r) => r.skill_canonical_name === item.skill_canonical,
          ) || {
            skill_canonical_name: item.skill_canonical,
            required_level: 3,
          };

          const scoredVideo = scoreResource(
            videoCandidate,
            teachesLevel,
            req,
            requestedSet,
            input.languagePref ?? 'both',
          );
          skillResources.push(scoredVideo);
        }
      }
      const selectedResourceIds = input.selectedResources?.[item.skill_canonical];
      const chosenSkillResources =
        selectedResourceIds && selectedResourceIds.length > 0
          ? skillResources.filter((resource) => selectedResourceIds.includes(resource.id))
          : skillResources;
      const languageSafeResources = preferDisplayLanguageResources(
        chosenSkillResources,
        input.languagePref ?? 'both',
      );
      const boundedSkillResources = keepOnePrimaryVideo(languageSafeResources).slice(
        0,
        MAX_RESOURCES_PER_STEP,
      );
      const resources = boundedSkillResources.map((resource) => ({
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

      const translated_display =
        input.translateDisplay && input.languagePref === 'vi'
          ? await this.displayTranslation?.translateDisplay({
              locale: 'vi',
              title: item.display_name,
              description: resources[0]?.description,
              reason: `Recommended for ${item.display_name}.`,
            })
          : undefined;

      steps.push({
        skill_canonical: item.skill_canonical,
        display_name: item.display_name,
        strategy: 'deep_build',
        estimated_hours: item.estimated_hours,
        priority: item.priority,
        resources,
        source_refs: input.sourceRefs,
        translated_display,
        recommended_courses: boundedSkillResources
          .filter((resource) => resource.source_type === 'course')
          .slice(0, MAX_RECOMMENDED_COURSES_PER_STEP)
          .map(toRecommendedCourse),
        lesson_content: getSkillBridgeLessonContent(
          item.skill_canonical,
          boundedSkillResources.map((resource) => resource.id),
        ),
      });
    }

    const ai_summary =
      steps.length === 0
        ? 'No selected learnable gaps yet.'
        : `Focus on ${steps.length} selected skill${steps.length > 1 ? 's' : ''}.`;

    return {
      budget_hours: plan.budget_hours,
      steps,
      sessions: planRoadmapSchedule(steps, input.budget),
      not_feasible_items: [],
      ai_summary,
      source_refs: input.sourceRefs,
    };
  }
}

function applySkillSelection(
  learnItems: UnifiedDevelopmentPlanItem[],
  input: Pick<
    Parameters<RoadmapComposerService['compose']>[0],
    'selectedSkillOrder' | 'excludedSkills'
  >,
): UnifiedDevelopmentPlanItem[] {
  const excluded = new Set((input.excludedSkills ?? []).map((item) => item.toLowerCase()));
  const order = new Map(
    (input.selectedSkillOrder ?? []).map((skill, index) => [skill.toLowerCase(), index]),
  );

  return [...learnItems]
    .filter((item) => !excluded.has(canonicalOf(item).toLowerCase()))
    .sort((a, b) => {
      const ai = order.get(canonicalOf(a).toLowerCase());
      const bi = order.get(canonicalOf(b).toLowerCase());
      if (ai != null && bi != null) return ai - bi;
      if (ai != null) return -1;
      if (bi != null) return 1;
      return 0;
    });
}

function preferDisplayLanguageResources(
  resources: ScoredResource[],
  languagePref: LanguagePref,
): ScoredResource[] {
  const safeResources = resources.filter(isSafeDisplayResource);
  if (languagePref === 'both') return safeResources.length > 0 ? safeResources : resources;

  const preferredSafe = safeResources.filter((resource) => resource.language === languagePref);
  if (preferredSafe.length > 0) return preferredSafe;

  const preferred = resources.filter((resource) => resource.language === languagePref);
  if (preferred.length > 0) return preferred;

  return safeResources.length > 0 ? safeResources : resources;
}

function isSafeDisplayResource(resource: ScoredResource): boolean {
  if (resource.source_type !== 'course') return true;
  const title = resource.title.toLowerCase();
  const url = resource.url?.toLowerCase() ?? '';
  if (/[\u0400-\u04ff\u0600-\u06ff]/u.test(resource.title)) return false;
  if (/-fr(?:$|[/?#])|[/?&]lang=fr\b/.test(url)) return false;
  return !/\b(cr\u00e9er|creer|comp\u00e9tences|competences|utilisateur|dynamiques|notions|cl\u00e9s|cles|entreprise)\b/i.test(
    title,
  );
}

function canonicalOf(item: UnifiedDevelopmentPlanItem): string {
  return item.skill_canonical ?? item.display_name;
}

function orderBySelectedSkill<T extends { skill_canonical: string }>(
  items: T[],
  selectedSkillOrder: string[] | undefined,
): T[] {
  if (!selectedSkillOrder?.length) return items;
  const order = new Map(selectedSkillOrder.map((skill, index) => [skill.toLowerCase(), index]));

  return [...items].sort((a, b) => {
    const ai = order.get(a.skill_canonical.toLowerCase());
    const bi = order.get(b.skill_canonical.toLowerCase());
    if (ai != null && bi != null) return ai - bi;
    if (ai != null) return -1;
    if (bi != null) return 1;
    return 0;
  });
}

function primaryResourceHours(resources: ScoredResource[]): number | null {
  const primaryMinutes = resources[0]?.duration_minutes;
  return Number.isFinite(primaryMinutes) && primaryMinutes > 0 ? primaryMinutes / 60 : null;
}

function keepOnePrimaryVideo(resources: ScoredResource[]): ScoredResource[] {
  let hasVideo = false;
  return resources.filter((resource) => {
    if (resource.source_type !== 'video') return true;
    if (hasVideo) return false;
    hasVideo = true;
    return true;
  });
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
