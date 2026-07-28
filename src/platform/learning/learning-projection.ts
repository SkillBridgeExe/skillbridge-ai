import type { LearningRoadmapCadenceDraft } from '../../database/entities/learning-roadmap.entity';

interface ProjectionSession {
  id: string;
  scheduledStartAt: Date;
}

export interface LearningProjection {
  start_date: string;
  estimated_completion_date: string | null;
  study_days_per_week: number;
  session_minutes: number;
  total_units: number;
  completed_units: number;
  planned_units_by_today: number;
  missed_units: number;
  pace_percentage: number;
  days_remaining: number;
}

export function computeLearningProjection(input: {
  cadence: LearningRoadmapCadenceDraft;
  sessions: ProjectionSession[];
  completedSessionIds: ReadonlySet<string>;
  today: string;
}): LearningProjection {
  const ordered = [...input.sessions].sort(
    (left, right) => left.scheduledStartAt.getTime() - right.scheduledStartAt.getTime(),
  );
  const dated = ordered.map((session) => ({
    ...session,
    scheduledDate: dateInTimezone(session.scheduledStartAt, input.cadence.timezone),
  }));
  const plannedUnits = dated.filter((session) => session.scheduledDate <= input.today).length;
  const missedUnits = dated.filter(
    (session) => session.scheduledDate < input.today && !input.completedSessionIds.has(session.id),
  ).length;
  const completedUnits = dated.filter((session) =>
    input.completedSessionIds.has(session.id),
  ).length;
  const completionDate = dated.at(-1)?.scheduledDate ?? null;

  return {
    start_date: input.cadence.start_date,
    estimated_completion_date: completionDate,
    study_days_per_week: input.cadence.study_days_per_week,
    session_minutes: input.cadence.session_minutes,
    total_units: dated.length,
    completed_units: completedUnits,
    planned_units_by_today: plannedUnits,
    missed_units: missedUnits,
    pace_percentage: plannedUnits === 0 ? 100 : Math.round((completedUnits / plannedUnits) * 100),
    days_remaining: completionDate
      ? Math.max(0, differenceInUtcDays(input.today, completionDate))
      : 0,
  };
}

export function todayInLearningTimezone(timezone: string, now = new Date()): string {
  return dateInTimezone(now, timezone);
}

function dateInTimezone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function differenceInUtcDays(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}
