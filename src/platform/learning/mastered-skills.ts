import {
  getSkillBridgeLessonContent,
  SKILLBRIDGE_LESSON_SKILLS,
} from '../../modules/roadmap/skillbridge-lesson-content';
import { computeObjectiveMastery } from './quiz-mastery';

/**
 * V2 (Wave VALUE_CHAIN): pure session-rows → mastered-skill-canonicals aggregation.
 *
 * Join strategy: `learning_session_progress` has NO skill column — the FE PUTs progress under
 * `roadmap-${slug(skill_canonical)}` (see FE learning-roadmap.service.ts roadmapToWeekPlans), and
 * quiz question ids are NOT globally unique across lessons (fallback blueprints reuse ids), so the
 * session-id slug is the cheapest correct join. Callers fetch ALL of a user's rows in ONE query and
 * this function maps + judges them in memory — no per-skill N+1 lookups.
 * ponytail: if the FE ever changes its session-id scheme, this map is the single place to extend.
 */

/** FE slugPart clone (learning-roadmap.service.ts) — e.g. 'node_js' → 'node-js'. */
const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const SESSION_ID_TO_SKILL: ReadonlyMap<string, string> = new Map(
  SKILLBRIDGE_LESSON_SKILLS.map((skill) => [`roadmap-${slug(skill)}`, skill]),
);

export interface LearningProgressRowLike {
  sessionId: string;
  quizAttempts: unknown;
}

/** The skill canonical a learning-session row tracks, or null for unknown session ids. */
export function skillForSessionId(sessionId: string): string | null {
  return SESSION_ID_TO_SKILL.get(sessionId) ?? null;
}

/**
 * Skill canonicals whose SkillBridge lesson the user has FULLY mastered: EVERY learning objective
 * passes Khoa's existing per-objective predicate (computeObjectiveMastery — no new threshold
 * invented; the aggregate "all objectives mastered" does not exist anywhere upstream).
 * Rows with unknown session ids / malformed attempts are skipped, never thrown on.
 */
export function masteredSkillCanonicals(rows: LearningProgressRowLike[]): Set<string> {
  const mastered = new Set<string>();
  for (const row of rows) {
    const skill = SESSION_ID_TO_SKILL.get(row.sessionId);
    if (!skill || mastered.has(skill)) continue;
    const lesson = getSkillBridgeLessonContent(skill);
    if (!lesson || lesson.learning_objectives.length === 0) continue;
    const attempts = row.quizAttempts;
    if (!attempts || typeof attempts !== 'object' || Array.isArray(attempts)) continue;
    const attemptMap = attempts as Record<string, { is_correct?: unknown } | undefined>;
    const results = lesson.quiz_bank
      .filter((question) => attemptMap[question.id])
      .map((question) => ({
        questionId: question.id,
        objectiveId: question.objective_id,
        isCorrect: attemptMap[question.id]?.is_correct === true,
      }));
    const allObjectivesMastered = lesson.learning_objectives.every(
      (objective) => computeObjectiveMastery(objective.id, results).mastered,
    );
    if (allObjectivesMastered) mastered.add(skill);
  }
  return mastered;
}
