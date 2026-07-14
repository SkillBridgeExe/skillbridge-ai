import type { FeasibilityBudget } from './feasibility-planner';
import type {
  ComposedRoadmapStep,
  RoadmapSession,
  RoadmapSourceRef,
} from './roadmap-composer';

const DEFAULT_MINUTES_PER_SESSION = 120;
const DEFAULT_SESSIONS_PER_WEEK = 14;

interface RoadmapSessionDraft {
  idSuffix: string;
  title: string;
  mode: RoadmapSession['mode'];
  skill_canonicals: string[];
  primary_skill: string;
  resource_ids: string[];
  source_refs: RoadmapSourceRef[];
}

export function planRoadmapSchedule(
  steps: ComposedRoadmapStep[],
  budget: FeasibilityBudget,
): RoadmapSession[] {
  const minutesPerSession = budget.minutes_per_session ?? DEFAULT_MINUTES_PER_SESSION;
  const sessionsPerWeek = budget.sessions_per_week ?? DEFAULT_SESSIONS_PER_WEEK;
  const studyDaysPerWeek = budget.study_days_per_week ?? 7;
  const sessionsPerDay = sessionsPerDayFromWeeklyBudget(sessionsPerWeek, studyDaysPerWeek);
  const groups: RoadmapSessionDraft[][] = [];

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const bundle = bundleCandidate(steps, stepIndex, minutesPerSession);
    if (bundle.length > 1) {
      groups.push([
        {
          idSuffix: bundle.map((step) => slugPart(step.skill_canonical)).join('-'),
          title: bundle.map((step) => step.display_name).join(' + '),
          mode: 'bundled_skills',
          skill_canonicals: bundle.map((step) => step.skill_canonical),
          primary_skill: bundle[0].skill_canonical,
          resource_ids: unique(bundle.flatMap((step) => step.resources.map((resource) => resource.id))),
          source_refs: uniqueSourceRefs(bundle.flatMap((step) => step.source_refs ?? [])),
        },
      ]);
      stepIndex += bundle.length - 1;
      continue;
    }

    const step = steps[stepIndex];
    const resourceIds = step.resources.map((resource) => resource.id);
    const sessionCount = Math.max(1, Math.ceil((step.estimated_hours * 60) / minutesPerSession));
    const drafts: RoadmapSessionDraft[] = [];

    for (let index = 0; index < sessionCount; index += 1) {
      drafts.push({
        idSuffix: slugPart(step.skill_canonical),
        title:
          sessionCount === 1
            ? step.display_name
            : `${step.display_name} ${index + 1}/${sessionCount}`,
        mode: step.resources.some((resource) => resource.source_type === 'mini_project')
          ? 'mini_project'
          : 'single_skill',
        skill_canonicals: [step.skill_canonical],
        primary_skill: step.skill_canonical,
        resource_ids: resourceIds,
        source_refs: step.source_refs ?? [],
      });
    }
    groups.push(drafts);
  }

  return scheduleGroups(groups, {
    minutesPerSession,
    sessionsPerDay,
    studyDaysPerWeek,
  });
}

function scheduleGroups(
  groups: RoadmapSessionDraft[][],
  options: {
    minutesPerSession: number;
    sessionsPerDay: number;
    studyDaysPerWeek: number;
  },
): RoadmapSession[] {
  const activeDays = studyDays(options.studyDaysPerWeek);
  const lanes: Array<RoadmapSessionDraft[] | null> = Array.from(
    { length: options.sessionsPerDay },
    () => null,
  );
  const sessions: RoadmapSession[] = [];
  let nextGroupIndex = 0;
  let weekNumber = 1;
  let sessionIndex = 1;

  const fillOpenLanes = () => {
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
      if (lanes[laneIndex] || nextGroupIndex >= groups.length) continue;
      lanes[laneIndex] = [...groups[nextGroupIndex]];
      nextGroupIndex += 1;
    }
  };

  while (nextGroupIndex < groups.length || lanes.some((lane) => lane && lane.length > 0)) {
    for (const day of activeDays) {
      fillOpenLanes();
      if (!lanes.some((lane) => lane && lane.length > 0)) break;

      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
        const lane = lanes[laneIndex];
        if (!lane) continue;
        const draft = lane.shift();
        if (!draft) {
          lanes[laneIndex] = null;
          continue;
        }

        sessions.push({
          id: `roadmap-w${weekNumber}-s${sessionIndex}-${draft.idSuffix}`,
          week_number: weekNumber,
          session_index: sessionIndex,
          lane_index: laneIndex,
          suggested_day_of_week: day,
          duration_minutes: options.minutesPerSession,
          title: draft.title,
          mode: draft.mode,
          skill_canonicals: draft.skill_canonicals,
          primary_skill: draft.primary_skill,
          resource_ids: draft.resource_ids,
          source_refs: draft.source_refs,
        });
        sessionIndex += 1;

        if (lane.length === 0) lanes[laneIndex] = null;
      }
    }

    weekNumber += 1;
    sessionIndex = 1;
  }

  return sessions;
}

function bundleCandidate(
  steps: ComposedRoadmapStep[],
  startIndex: number,
  minutesPerSession: number,
): ComposedRoadmapStep[] {
  const first = steps[startIndex];
  if (!canBundle(first, minutesPerSession)) return [];

  const sourceKey = relatedSourceKey(first);
  const bundle: ComposedRoadmapStep[] = [];
  let usedMinutes = 0;

  for (let index = startIndex; index < steps.length; index += 1) {
    const step = steps[index];
    const stepMinutes = Math.ceil(step.estimated_hours * 60);
    if (!canBundle(step, minutesPerSession)) break;
    if (relatedSourceKey(step) !== sourceKey) break;
    if (usedMinutes + stepMinutes > minutesPerSession) break;
    bundle.push(step);
    usedMinutes += stepMinutes;
  }

  return bundle.length > 1 ? bundle : [];
}

function canBundle(step: ComposedRoadmapStep, minutesPerSession: number): boolean {
  if (step.resources.some((resource) => resource.source_type === 'mini_project')) return false;
  return Math.ceil(step.estimated_hours * 60) <= Math.floor(minutesPerSession / 2);
}

function relatedSourceKey(step: ComposedRoadmapStep): string {
  const source = step.source_refs?.[0];
  return source ? `${source.type}:${source.id}` : 'unknown';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueSourceRefs(values: RoadmapSourceRef[]): RoadmapSourceRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.type}:${value.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sessionsPerDayFromWeeklyBudget(sessionsPerWeek: number, studyDaysPerWeek: number): number {
  return Math.max(1, Math.floor(sessionsPerWeek / Math.max(1, studyDaysPerWeek)));
}

function studyDays(studyDaysPerWeek: number): number[] {
  const days = [1, 2, 3, 4, 5, 6, 0];
  return days.slice(0, Math.max(1, Math.min(7, studyDaysPerWeek)));
}

function slugPart(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'skill';
}
