import { BadRequestException } from '@nestjs/common';

export const ADMIN_REVENUE_PERIODS = [
  'TODAY',
  'YESTERDAY',
  'THIS_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_YEAR',
  'LAST_YEAR',
  'CUSTOM',
] as const;

export type AdminRevenuePeriod = (typeof ADMIN_REVENUE_PERIODS)[number];
export type AdminRevenueWindowPeriod = AdminRevenuePeriod | 'ROLLING_DAYS';

export type AdminRevenueWindowQuery = {
  period?: AdminRevenuePeriod;
  from?: string;
  to?: string;
  rangeDays?: number;
};

export type ResolvedAdminRevenueWindow = {
  period: AdminRevenueWindowPeriod;
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
  timezone: 'Asia/Ho_Chi_Minh';
};

const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;
const ICT_TIMEZONE = 'Asia/Ho_Chi_Minh' as const;

export function resolveAdminRevenueWindow(
  query: AdminRevenueWindowQuery = {},
  now = new Date(),
): ResolvedAdminRevenueWindow {
  const period = query.period;
  if (period === 'CUSTOM') return resolveCustomWindow(query.from, query.to);

  if (query.from || query.to) {
    throw invalidWindow('from and to are only valid with period=CUSTOM');
  }

  if (!period) {
    const rangeDays = query.rangeDays ?? 30;
    const from = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    return createResolvedWindow('ROLLING_DAYS', from, now);
  }

  const current = ictDateParts(now);
  const today = datePartsToDate(current);
  let from: Date;
  let to: Date;

  switch (period) {
    case 'TODAY':
      from = today;
      to = datePartsToDate(addIctDays(current, 1));
      break;
    case 'YESTERDAY':
      from = datePartsToDate(addIctDays(current, -1));
      to = today;
      break;
    case 'THIS_WEEK': {
      const dayOfWeek = new Date(
        Date.UTC(current.year, current.month - 1, current.day),
      ).getUTCDay();
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      const monday = addIctDays(current, -daysSinceMonday);
      from = datePartsToDate(monday);
      to = datePartsToDate(addIctDays(monday, 7));
      break;
    }
    case 'THIS_MONTH':
      from = datePartsToDate({ year: current.year, month: current.month, day: 1 });
      to = datePartsToDate(nextMonth(current.year, current.month));
      break;
    case 'LAST_MONTH': {
      const previous = previousMonth(current.year, current.month);
      from = datePartsToDate({ year: previous.year, month: previous.month, day: 1 });
      to = datePartsToDate({ year: current.year, month: current.month, day: 1 });
      break;
    }
    case 'THIS_YEAR':
      from = datePartsToDate({ year: current.year, month: 1, day: 1 });
      to = datePartsToDate({ year: current.year + 1, month: 1, day: 1 });
      break;
    case 'LAST_YEAR':
      from = datePartsToDate({ year: current.year - 1, month: 1, day: 1 });
      to = datePartsToDate({ year: current.year, month: 1, day: 1 });
      break;
    default:
      throw invalidWindow(`Unsupported revenue period: ${period}`);
  }

  return createResolvedWindow(period, from, to);
}

function resolveCustomWindow(fromInput?: string, toInput?: string): ResolvedAdminRevenueWindow {
  if (!fromInput || !toInput) {
    throw invalidWindow('CUSTOM revenue period requires both from and to');
  }
  const fromParts = parseIctDate(fromInput);
  const toParts = parseIctDate(toInput);
  const from = datePartsToDate(fromParts);
  const to = datePartsToDate(addIctDays(toParts, 1));
  if (from >= to) throw invalidWindow('Revenue window must not be inverted');
  return createResolvedWindow('CUSTOM', from, to);
}

function createResolvedWindow(
  period: AdminRevenueWindowPeriod,
  from: Date,
  to: Date,
): ResolvedAdminRevenueWindow {
  if (from >= to) throw invalidWindow('Revenue window must not be empty');
  return {
    period,
    from,
    to,
    fromDate: formatIctDate(from),
    toDate: formatIctDate(new Date(to.getTime() - 1)),
    timezone: ICT_TIMEZONE,
  };
}

type IctDateParts = { year: number; month: number; day: number };

function ictDateParts(value: Date): IctDateParts {
  const shifted = new Date(value.getTime() + ICT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function formatIctDate(value: Date): string {
  const parts = ictDateParts(value);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month
    .toString()
    .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

function parseIctDate(value: string): IctDateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw invalidWindow(`Invalid ICT date: ${value}`);
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const normalized = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day
  ) {
    throw invalidWindow(`Invalid ICT date: ${value}`);
  }
  return parts;
}

function datePartsToDate(parts: IctDateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - ICT_OFFSET_MS);
}

function addIctDays(parts: IctDateParts, days: number): IctDateParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function nextMonth(year: number, month: number): IctDateParts {
  return month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 };
}

function previousMonth(year: number, month: number): IctDateParts {
  return month === 1 ? { year: year - 1, month: 12, day: 1 } : { year, month: month - 1, day: 1 };
}

function invalidWindow(message: string): BadRequestException {
  return new BadRequestException({
    errorCode: 'INVALID_REVENUE_WINDOW',
    message,
  });
}
