import {
  ScheduledLearningModule,
  ScheduledLearningSession,
  SchedulableLearningModule,
  orderLearningModules,
  zonedDateTimeToUtc,
} from './learning-scheduler';

const INTERNAL_STUDY_TIME = '12:00';
const MAX_PROJECTION_DAYS = 5 * 366;
const STUDY_DAY_OFFSETS: Readonly<Record<number, readonly number[]>> = {
  1: [0],
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 2, 4, 6],
  5: [0, 1, 3, 4, 6],
  6: [0, 1, 2, 3, 4, 5],
  7: [0, 1, 2, 3, 4, 5, 6],
};

export interface ScheduleLearningCadenceInput {
  modules: SchedulableLearningModule[];
  timezone: string;
  startDate: string;
  studyDaysPerWeek: number;
  sessionMinutes: number;
}

export interface LearningCadenceResult {
  modules: ScheduledLearningModule[];
  sessions: ScheduledLearningSession[];
  scheduledMinutes: number;
  estimatedCompletionDate: string | null;
}

export function buildStudyWeekdays(startDate: string, studyDaysPerWeek: number): number[] {
  assertDate(startDate, 'startDate');
  assertStudyDays(studyDaysPerWeek);
  const startWeekday = isoWeekday(startDate);
  return STUDY_DAY_OFFSETS[studyDaysPerWeek].map((offset) => ((startWeekday - 1 + offset) % 7) + 1);
}

export function scheduleLearningCadence(
  input: ScheduleLearningCadenceInput,
): LearningCadenceResult {
  assertDate(input.startDate, 'startDate');
  assertStudyDays(input.studyDaysPerWeek);
  assertTimezone(input.timezone);
  if (!Number.isInteger(input.sessionMinutes) || input.sessionMinutes <= 0) {
    throw new Error('sessionMinutes must be a positive integer');
  }

  const ordered = orderLearningModules(input.modules);
  const studyWeekdays = new Set(buildStudyWeekdays(input.startDate, input.studyDaysPerWeek));
  const sessions: ScheduledLearningSession[] = [];
  let date = input.startDate;
  let elapsedDays = 0;

  for (const module of ordered) {
    let remainingMinutes = Math.max(1, Math.ceil(module.estimatedMinutes));
    let sequence = 1;

    while (remainingMinutes > 0) {
      while (!studyWeekdays.has(isoWeekday(date))) {
        date = addUtcDays(date, 1);
        elapsedDays += 1;
        assertProjectionHorizon(elapsedDays);
      }

      const durationMinutes = Math.min(input.sessionMinutes, remainingMinutes);
      sessions.push({
        skillCanonical: module.skillCanonical,
        sequence,
        scheduledStartAt: zonedDateTimeToUtc(date, INTERNAL_STUDY_TIME, input.timezone),
        durationMinutes,
      });
      remainingMinutes -= durationMinutes;
      sequence += 1;
      if (remainingMinutes > 0 || module !== ordered.at(-1)) {
        date = addUtcDays(date, 1);
        elapsedDays += 1;
        assertProjectionHorizon(elapsedDays);
      }
    }
  }

  return {
    modules: ordered.map((module, index) => ({
      ...module,
      rank: index + 1,
      feasibility: 'FEASIBLE',
    })),
    sessions,
    scheduledMinutes: sessions.reduce((sum, session) => sum + session.durationMinutes, 0),
    estimatedCompletionDate:
      sessions.length > 0
        ? dateInTimezone(sessions.at(-1)!.scheduledStartAt, input.timezone)
        : null,
  };
}

export function projectCadenceDates(input: {
  timezone: string;
  startDate: string;
  studyDaysPerWeek: number;
  count: number;
}): Date[] {
  assertDate(input.startDate, 'startDate');
  assertStudyDays(input.studyDaysPerWeek);
  assertTimezone(input.timezone);
  if (!Number.isInteger(input.count) || input.count < 0) {
    throw new Error('count must be a non-negative integer');
  }
  const studyWeekdays = new Set(buildStudyWeekdays(input.startDate, input.studyDaysPerWeek));
  const dates: Date[] = [];
  let date = input.startDate;
  let elapsedDays = 0;
  while (dates.length < input.count) {
    if (studyWeekdays.has(isoWeekday(date))) {
      dates.push(zonedDateTimeToUtc(date, INTERNAL_STUDY_TIME, input.timezone));
    }
    if (dates.length < input.count) {
      date = addUtcDays(date, 1);
      elapsedDays += 1;
      assertProjectionHorizon(elapsedDays);
    }
  }
  return dates;
}

function isoWeekday(date: string): number {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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

function assertDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} must use YYYY-MM-DD`);
  }
}

function assertStudyDays(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 7) {
    throw new Error('studyDaysPerWeek must be between 1 and 7');
  }
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new Error(`Unsupported learning timezone '${timezone}'`);
  }
}

function assertProjectionHorizon(elapsedDays: number): void {
  if (elapsedDays > MAX_PROJECTION_DAYS) {
    throw new Error('Learning projection exceeds the five-year safety horizon');
  }
}
