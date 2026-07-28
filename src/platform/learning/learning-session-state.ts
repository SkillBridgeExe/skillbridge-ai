export type LearningRuntimeSessionStatus = 'COMPLETED' | 'AVAILABLE';

interface RankedLearningModule {
  id: string;
  rank: number;
}

interface OrderedLearningSession {
  id: string;
  moduleId: string;
  sequence: number;
}

interface CompletionProgress {
  checkedChecklistItems: Record<string, string[]>;
  exerciseProofs: Record<string, string>;
}

export interface LearningCompletionValidation {
  complete: boolean;
  missing_section_ids: string[];
  missing_checklist_item_ids: string[];
  missing_exercise_ids: string[];
}

const MIN_REQUIRED_PROOF_LENGTH = 12;

export function isLearningSessionMarkedComplete(
  checkedChecklistItems: Record<string, string[]> | null | undefined,
): boolean {
  return checkedChecklistItems?.__session?.includes('completed') ?? false;
}

export function resolveModuleSessionStatuses(
  _modules: RankedLearningModule[],
  sessions: OrderedLearningSession[],
  completedSessionIds: ReadonlySet<string>,
): Map<string, LearningRuntimeSessionStatus> {
  const statuses = new Map<string, LearningRuntimeSessionStatus>();
  for (const session of sessions) {
    statuses.set(session.id, completedSessionIds.has(session.id) ? 'COMPLETED' : 'AVAILABLE');
  }
  return statuses;
}

export function validateLearningSessionCompletion(
  requiredTasks: Array<Record<string, unknown>>,
  progress: CompletionProgress,
): LearningCompletionValidation {
  const missingSectionIds = new Set<string>();
  const missingChecklistItemIds = new Set<string>();
  const missingExerciseIds = new Set<string>();
  let hasLessonTask = false;

  for (const task of requiredTasks) {
    if (task.type !== 'lesson') continue;
    hasLessonTask = true;
    const content = asRecord(task.content);

    for (const sectionValue of asArray(content?.sections)) {
      const section = asRecord(sectionValue);
      const sectionId = stringValue(section?.id);
      if (!sectionId) continue;
      const checklist = asArray(section?.checklist)
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => Boolean(item));

      if (checklist.length === 0) {
        if (!(progress.checkedChecklistItems[sectionId] ?? []).includes('__completed')) {
          missingSectionIds.add(sectionId);
        }
        continue;
      }

      const checked = new Set(progress.checkedChecklistItems[sectionId] ?? []);
      for (const item of checklist) {
        const itemId = stringValue(item.id);
        if (!itemId) continue;
        const proof = progress.exerciseProofs[`task:${sectionId}:${itemId}`]?.trim() ?? '';
        if (!checked.has(itemId) || proof.length < MIN_REQUIRED_PROOF_LENGTH) {
          missingChecklistItemIds.add(`${sectionId}:${itemId}`);
        }
      }
    }

    for (const exerciseValue of asArray(content?.exercises)) {
      const exercise = asRecord(exerciseValue);
      const exerciseId = stringValue(exercise?.id);
      const proof = exerciseId ? (progress.exerciseProofs[exerciseId]?.trim() ?? '') : '';
      if (exerciseId && proof.length < MIN_REQUIRED_PROOF_LENGTH) {
        missingExerciseIds.add(exerciseId);
      }
    }
  }

  if (!hasLessonTask) {
    for (const task of requiredTasks) {
      if (task.type !== 'resources') continue;
      for (const resourceValue of asArray(task.items)) {
        const resource = asRecord(resourceValue);
        const resourceId = stringValue(resource?.id);
        if (
          resourceId &&
          !(progress.checkedChecklistItems[resourceId] ?? []).includes('__completed')
        ) {
          missingSectionIds.add(resourceId);
        }
      }
    }
  }

  const result = {
    missing_section_ids: [...missingSectionIds],
    missing_checklist_item_ids: [...missingChecklistItemIds],
    missing_exercise_ids: [...missingExerciseIds],
  };
  return {
    complete:
      result.missing_section_ids.length === 0 &&
      result.missing_checklist_item_ids.length === 0 &&
      result.missing_exercise_ids.length === 0,
    ...result,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
