import type {
  LessonExerciseContent,
  LessonSectionContent,
  SkillBridgeLessonContent,
} from '../../modules/roadmap/skillbridge-lesson-content';

export type LearningTrack = 'FAST_TRACK' | 'FOUNDATION';
export type LearningScopeStatus = 'FULL' | 'CORE_ONLY' | 'INTRO_ONLY' | 'DEFERRED';
export type LearningLessonScopeStatus = 'INCLUDED' | 'OMITTED';

export interface LearningContentCandidate {
  skillCanonical: string;
  displayName: string;
  systemPriority: number;
  userRank?: number;
  prerequisites: string[];
  lessonContent?: SkillBridgeLessonContent;
}

export interface PlannedLearningLesson {
  id: string;
  title: string;
  summary: string;
  keyPoints: string[];
  estimatedMinutes: number;
  importance: 'CORE' | 'EXTENSION';
  kind: 'LEARN' | 'PRACTICE';
  scopeStatus: LearningLessonScopeStatus;
  omissionReason?: 'TIME_LIMIT' | 'PREREQUISITE' | 'LOWER_PRIORITY';
  section?: LessonSectionContent;
  exercise?: LessonExerciseContent;
}

export interface PlannedLearningModule {
  skillCanonical: string;
  displayName: string;
  rank: number;
  quickWinScore: number;
  estimatedMinutes: number;
  scheduledMinutes: number;
  scopeStatus: LearningScopeStatus;
  prerequisites: string[];
  lessons: PlannedLearningLesson[];
}

export interface LearningContentPlan {
  track: LearningTrack;
  capacityMinutes: number;
  scheduledMinutes: number;
  coveragePercentage: number;
  modules: PlannedLearningModule[];
}

interface LearningContentPlanInput {
  track: LearningTrack;
  capacityMinutes?: number;
  candidates: LearningContentCandidate[];
}

const WORDS_PER_MINUTE = 180;

export function estimateSectionMinutes(section: LessonSectionContent): number {
  const readingMinutes = Math.ceil(wordCount(section.body) / WORDS_PER_MINUTE);
  return roundToFive(clamp(10 + readingMinutes + section.checklist.length * 3, 15, 25));
}

export function estimateExerciseMinutes(exercise: LessonExerciseContent): number {
  return roundToFive(clamp(10 + exercise.acceptance_criteria.length * 5, 20, 30));
}

export function buildLearningContentPlan(input: LearningContentPlanInput): LearningContentPlan {
  const usesGoalDefinedScope = input.capacityMinutes === undefined;
  const candidateCount = input.candidates.length;
  const maxPriority = Math.max(1, ...input.candidates.map((item) => item.systemPriority));
  const candidateSkills = new Set(input.candidates.map((item) => item.skillCanonical));

  const modules = input.candidates.map((candidate) => {
    const lessons = toLessons(candidate.lessonContent);
    const estimatedMinutes = sumMinutes(lessons);
    const rankScore =
      candidateCount <= 1
        ? 1
        : 1 - ((candidate.userRank ?? candidateCount) - 1) / Math.max(1, candidateCount - 1);
    const impact = clamp(candidate.systemPriority / maxPriority, 0, 1);
    const effortAdvantage = 1 - Math.min(estimatedMinutes / 480, 1);
    const missingPrerequisites = candidate.prerequisites.filter((skill) =>
      candidateSkills.has(skill),
    ).length;
    const readiness = 1 - Math.min(missingPrerequisites / 3, 1);
    const quickWinScore = Math.round(
      100 * (impact * 0.45 + rankScore * 0.25 + effortAdvantage * 0.2 + readiness * 0.1),
    );
    return {
      candidate,
      lessons,
      estimatedMinutes,
      quickWinScore,
    };
  });

  const ordered =
    input.track === 'FAST_TRACK'
      ? topologicalOrder(modules, (a, b) => b.quickWinScore - a.quickWinScore)
      : topologicalOrder(modules, (a, b) => {
          const rankA = a.candidate.userRank ?? Number.MAX_SAFE_INTEGER;
          const rankB = b.candidate.userRank ?? Number.MAX_SAFE_INTEGER;
          return (
            rankA - rankB ||
            b.candidate.systemPriority - a.candidate.systemPriority ||
            a.candidate.skillCanonical.localeCompare(b.candidate.skillCanonical)
          );
        });

  const capacityMinutes =
    input.capacityMinutes === undefined
      ? ordered.reduce(
          (sum, entry) =>
            sum +
            sumMinutes(
              input.track === 'FAST_TRACK'
                ? entry.lessons.filter((lesson) => lesson.importance === 'CORE')
                : entry.lessons,
            ),
          0,
        )
      : Math.max(0, Math.floor(input.capacityMinutes));
  let remaining = capacityMinutes;
  let includedAnyModule = false;
  const planned = ordered.map((entry, index): PlannedLearningModule => {
    const core = entry.lessons.filter((lesson) => lesson.importance === 'CORE');
    const extensions = entry.lessons.filter((lesson) => lesson.importance === 'EXTENSION');
    const minimumBundleMinutes = sumMinutes(core);
    let includedIds = new Set<string>();

    if (usesGoalDefinedScope) {
      includedIds = new Set(
        (input.track === 'FAST_TRACK' ? core : entry.lessons).map((lesson) => lesson.id),
      );
    } else if (input.track === 'FOUNDATION') {
      if (entry.estimatedMinutes <= remaining) {
        includedIds = new Set(entry.lessons.map((lesson) => lesson.id));
      }
    } else if (minimumBundleMinutes <= remaining) {
      includedIds = new Set(core.map((lesson) => lesson.id));
      for (const lesson of extensions) {
        if (lesson.estimatedMinutes <= remaining - minimumBundleMinutes - sumIncludedExtensions()) {
          includedIds.add(lesson.id);
        }
      }
    } else if (!includedAnyModule) {
      const introduction = core.find((lesson) => lesson.kind === 'LEARN');
      if (introduction && introduction.estimatedMinutes <= remaining) {
        includedIds.add(introduction.id);
      }
    }

    const scheduledMinutes = entry.lessons
      .filter((lesson) => includedIds.has(lesson.id))
      .reduce((sum, lesson) => sum + lesson.estimatedMinutes, 0);
    remaining -= scheduledMinutes;
    if (scheduledMinutes > 0) includedAnyModule = true;

    const lessons = entry.lessons.map((lesson) =>
      includedIds.has(lesson.id)
        ? { ...lesson, scopeStatus: 'INCLUDED' as const }
        : {
            ...lesson,
            scopeStatus: 'OMITTED' as const,
            omissionReason: usesGoalDefinedScope
              ? ('LOWER_PRIORITY' as const)
              : ('TIME_LIMIT' as const),
          },
    );
    const includedCount = includedIds.size;
    const scopeStatus: LearningScopeStatus =
      includedCount === 0
        ? 'DEFERRED'
        : includedCount === entry.lessons.length
          ? 'FULL'
          : core.every((lesson) => includedIds.has(lesson.id))
            ? 'CORE_ONLY'
            : 'INTRO_ONLY';

    return {
      skillCanonical: entry.candidate.skillCanonical,
      displayName: entry.candidate.displayName,
      rank: index + 1,
      quickWinScore: entry.quickWinScore,
      estimatedMinutes: entry.estimatedMinutes,
      scheduledMinutes,
      scopeStatus,
      prerequisites: entry.candidate.prerequisites,
      lessons,
    };

    function sumIncludedExtensions(): number {
      return extensions
        .filter((lesson) => includedIds.has(lesson.id))
        .reduce((sum, lesson) => sum + lesson.estimatedMinutes, 0);
    }
  });

  const scheduledMinutes = planned.reduce((sum, module) => sum + module.scheduledMinutes, 0);
  const totalImpact = planned.reduce(
    (sum, module) =>
      sum +
      (input.candidates.find((item) => item.skillCanonical === module.skillCanonical)
        ?.systemPriority ?? 0),
    0,
  );
  const coveredImpact = planned.reduce((sum, module) => {
    const priority =
      input.candidates.find((item) => item.skillCanonical === module.skillCanonical)
        ?.systemPriority ?? 0;
    const fraction =
      module.estimatedMinutes > 0 ? module.scheduledMinutes / module.estimatedMinutes : 0;
    return sum + priority * fraction;
  }, 0);

  return {
    track: input.track,
    capacityMinutes,
    scheduledMinutes,
    coveragePercentage:
      totalImpact > 0 ? Math.round(clamp((coveredImpact / totalImpact) * 100, 0, 100)) : 0,
    modules: planned,
  };
}

function toLessons(content: SkillBridgeLessonContent | undefined): PlannedLearningLesson[] {
  if (!content) return [];
  const sections = content.sections.map(
    (section, index): PlannedLearningLesson => ({
      id: `${content.skill_canonical}:section:${section.id}`,
      title: section.title,
      summary: section.body,
      keyPoints: section.checklist.map((item) => item.label),
      estimatedMinutes: estimateSectionMinutes(section),
      importance: index === 0 ? 'CORE' : 'EXTENSION',
      kind: 'LEARN',
      scopeStatus: 'OMITTED',
      section,
    }),
  );
  const practices = content.exercises.map(
    (exercise): PlannedLearningLesson => ({
      id: `${content.skill_canonical}:exercise:${exercise.id}`,
      title: exercise.title,
      summary: exercise.prompt,
      keyPoints: exercise.acceptance_criteria,
      estimatedMinutes: estimateExerciseMinutes(exercise),
      importance: 'CORE',
      kind: 'PRACTICE',
      scopeStatus: 'OMITTED',
      exercise,
    }),
  );
  return [...sections, ...practices];
}

function topologicalOrder<T extends { candidate: LearningContentCandidate }>(
  modules: T[],
  compare: (a: T, b: T) => number,
): T[] {
  const pending = new Map(modules.map((module) => [module.candidate.skillCanonical, module]));
  const ordered: T[] = [];
  while (pending.size > 0) {
    const available = [...pending.values()]
      .filter((module) => module.candidate.prerequisites.every((skill) => !pending.has(skill)))
      .sort(compare);
    if (available.length === 0) throw new Error('Learning prerequisite graph contains a cycle.');
    const next = available[0];
    ordered.push(next);
    pending.delete(next.candidate.skillCanonical);
  }
  return ordered;
}

function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

function sumMinutes(items: Array<{ estimatedMinutes: number }>): number {
  return items.reduce((sum, item) => sum + item.estimatedMinutes, 0);
}

function roundToFive(value: number): number {
  return Math.ceil(value / 5) * 5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
