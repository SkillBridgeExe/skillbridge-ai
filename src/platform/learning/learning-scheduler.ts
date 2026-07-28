export interface SchedulableLearningModule {
  skillCanonical: string;
  displayName: string;
  estimatedMinutes: number;
  systemPriority: number;
  userRank?: number;
  prerequisites: string[];
}

export interface LearningScheduleSlot {
  isoWeekday: number;
  startTime: string;
  durationMinutes: number;
}

export interface ScheduledLearningSession {
  skillCanonical: string;
  sequence: number;
  scheduledStartAt: Date;
  durationMinutes: number;
}

export interface ScheduledLearningModule extends SchedulableLearningModule {
  rank: number;
  feasibility: 'FEASIBLE' | 'DEFERRED';
}

export interface LearningScheduleResult {
  modules: ScheduledLearningModule[];
  sessions: ScheduledLearningSession[];
  deferred: Array<{ skillCanonical: string; remainingMinutes: number }>;
  capacityMinutes: number;
  scheduledMinutes: number;
}

export interface ScheduleLearningModulesInput {
  modules: SchedulableLearningModule[];
  timezone: string;
  startDate: string;
  deadline: string;
  sessionMinutes: number;
  slots: LearningScheduleSlot[];
}

interface SlotOccurrence {
  startAt: Date;
  availableMinutes: number;
  usedMinutes: number;
}

const MIN_USABLE_LEARNING_MINUTES = 15;

export function scheduleLearningModules(
  input: ScheduleLearningModulesInput,
): LearningScheduleResult {
  assertDate(input.startDate, 'startDate');
  assertDate(input.deadline, 'deadline');
  if (input.deadline < input.startDate) throw new Error('Learning deadline is before startDate.');
  assertTimezone(input.timezone);
  if (input.sessionMinutes <= 0) throw new Error('sessionMinutes must be positive.');

  const ordered = orderLearningModules(input.modules);
  const occurrences = buildSlotOccurrences(input);
  const sessions: ScheduledLearningSession[] = [];
  const deferred: LearningScheduleResult['deferred'] = [];
  const scheduledModules: ScheduledLearningModule[] = [];
  let occurrenceIndex = 0;

  for (let moduleIndex = 0; moduleIndex < ordered.length; moduleIndex += 1) {
    const module = ordered[moduleIndex];
    let remainingMinutes = Math.max(1, Math.ceil(module.estimatedMinutes));
    let sequence = 1;

    while (remainingMinutes > 0 && occurrenceIndex < occurrences.length) {
      const occurrence = occurrences[occurrenceIndex];
      const freeMinutes = occurrence.availableMinutes - occurrence.usedMinutes;
      if (freeMinutes <= 0) {
        occurrenceIndex += 1;
        continue;
      }
      const durationMinutes = Math.min(input.sessionMinutes, remainingMinutes, freeMinutes);
      sessions.push({
        skillCanonical: module.skillCanonical,
        sequence,
        scheduledStartAt: new Date(occurrence.startAt.getTime() + occurrence.usedMinutes * 60_000),
        durationMinutes,
      });
      occurrence.usedMinutes += durationMinutes;
      remainingMinutes -= durationMinutes;
      sequence += 1;
      if (occurrence.usedMinutes >= occurrence.availableMinutes) occurrenceIndex += 1;
    }

    if (remainingMinutes > 0) {
      deferred.push({ skillCanonical: module.skillCanonical, remainingMinutes });
    }
    scheduledModules.push({
      ...module,
      rank: moduleIndex + 1,
      feasibility: remainingMinutes === 0 ? 'FEASIBLE' : 'DEFERRED',
    });
  }

  return {
    modules: scheduledModules,
    sessions,
    deferred,
    capacityMinutes: occurrences.reduce((sum, slot) => sum + slot.availableMinutes, 0),
    scheduledMinutes: sessions.reduce((sum, session) => sum + session.durationMinutes, 0),
  };
}

export function orderLearningModules(
  modules: SchedulableLearningModule[],
): SchedulableLearningModule[] {
  const pending = new Map(modules.map((module) => [module.skillCanonical, module]));
  if (pending.size !== modules.length)
    throw new Error('Learning modules contain duplicate skills.');
  const ordered: SchedulableLearningModule[] = [];

  while (pending.size > 0) {
    const available = [...pending.values()]
      .filter((module) => module.prerequisites.every((skill) => !pending.has(skill)))
      .sort((a, b) => {
        const rankA = a.userRank ?? Number.MAX_SAFE_INTEGER;
        const rankB = b.userRank ?? Number.MAX_SAFE_INTEGER;
        return rankA - rankB || b.systemPriority - a.systemPriority;
      });
    if (available.length === 0) throw new Error('Learning prerequisite graph contains a cycle.');
    const next = available[0];
    ordered.push(next);
    pending.delete(next.skillCanonical);
  }
  return ordered;
}

function buildSlotOccurrences(input: ScheduleLearningModulesInput): SlotOccurrence[] {
  const slotsByWeekday = new Map<number, LearningScheduleSlot[]>();
  for (const slot of input.slots) {
    if (!Number.isInteger(slot.isoWeekday) || slot.isoWeekday < 1 || slot.isoWeekday > 7) {
      throw new Error('Learning slot isoWeekday must be between 1 and 7.');
    }
    if (slot.durationMinutes <= 0) throw new Error('Learning slot duration must be positive.');
    const sameDay = slotsByWeekday.get(slot.isoWeekday) ?? [];
    sameDay.push(slot);
    slotsByWeekday.set(slot.isoWeekday, sameDay);
  }

  const occurrences: SlotOccurrence[] = [];
  for (let date = input.startDate; date <= input.deadline; date = addUtcDays(date, 1)) {
    const jsWeekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const isoWeekday = jsWeekday === 0 ? 7 : jsWeekday;
    for (const slot of slotsByWeekday.get(isoWeekday) ?? []) {
      const fullBlocks = Math.floor(slot.durationMinutes / input.sessionMinutes);
      const remainder = slot.durationMinutes % input.sessionMinutes;
      const usableMinutes =
        fullBlocks * input.sessionMinutes +
        (remainder >= MIN_USABLE_LEARNING_MINUTES ? remainder : 0);
      if (usableMinutes === 0) continue;
      occurrences.push({
        startAt: zonedDateTimeToUtc(date, slot.startTime, input.timezone),
        availableMinutes: usableMinutes,
        usedMinutes: 0,
      });
    }
  }
  return occurrences.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

export function zonedDateTimeToUtc(date: string, time: string, timezone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    throw new Error(`Invalid learning slot date/time '${date} ${time}'.`);
  }
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = new Date(desiredAsUtc);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(guess)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const renderedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    guess = new Date(guess.getTime() + (desiredAsUtc - renderedAsUtc));
  }
  return guess;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function assertDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new Error(`Unsupported learning timezone '${timezone}'.`);
  }
}
