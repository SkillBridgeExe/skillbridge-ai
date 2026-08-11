import { BadRequestException } from '@nestjs/common';
import { resolveAdminRevenueWindow, type AdminRevenueWindowQuery } from './admin-revenue-window';

const NOW = new Date('2026-08-11T05:30:00.000Z'); // 12:30 ICT, Tuesday

function dates(query: AdminRevenueWindowQuery) {
  const window = resolveAdminRevenueWindow(query, NOW);
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    fromDate: window.fromDate,
    toDate: window.toDate,
    period: window.period,
    timezone: window.timezone,
  };
}

describe('resolveAdminRevenueWindow', () => {
  it('resolves today in ICT and uses an exclusive upper bound', () => {
    expect(dates({ period: 'TODAY' })).toEqual({
      from: '2026-08-10T17:00:00.000Z',
      to: '2026-08-11T17:00:00.000Z',
      fromDate: '2026-08-11',
      toDate: '2026-08-11',
      period: 'TODAY',
      timezone: 'Asia/Ho_Chi_Minh',
    });
  });

  it('resolves yesterday, this week, and this month from ICT calendar boundaries', () => {
    expect(dates({ period: 'YESTERDAY' })).toMatchObject({
      from: '2026-08-09T17:00:00.000Z',
      to: '2026-08-10T17:00:00.000Z',
      fromDate: '2026-08-10',
      toDate: '2026-08-10',
    });
    expect(dates({ period: 'THIS_WEEK' })).toMatchObject({
      from: '2026-08-09T17:00:00.000Z',
      to: '2026-08-16T17:00:00.000Z',
      fromDate: '2026-08-10',
      toDate: '2026-08-16',
    });
    expect(dates({ period: 'THIS_MONTH' })).toMatchObject({
      from: '2026-07-31T17:00:00.000Z',
      to: '2026-08-31T17:00:00.000Z',
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
    });
  });

  it('resolves the previous month and year boundaries', () => {
    expect(dates({ period: 'LAST_MONTH' })).toMatchObject({
      from: '2026-06-30T17:00:00.000Z',
      to: '2026-07-31T17:00:00.000Z',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect(dates({ period: 'THIS_YEAR' })).toMatchObject({
      from: '2025-12-31T17:00:00.000Z',
      to: '2026-12-31T17:00:00.000Z',
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });
    expect(dates({ period: 'LAST_YEAR' })).toMatchObject({
      from: '2024-12-31T17:00:00.000Z',
      to: '2025-12-31T17:00:00.000Z',
      fromDate: '2025-01-01',
      toDate: '2025-12-31',
    });
  });

  it('resolves a custom inclusive ICT date range', () => {
    expect(dates({ period: 'CUSTOM', from: '2026-08-01', to: '2026-08-11' })).toEqual({
      from: '2026-07-31T17:00:00.000Z',
      to: '2026-08-11T17:00:00.000Z',
      fromDate: '2026-08-01',
      toDate: '2026-08-11',
      period: 'CUSTOM',
      timezone: 'Asia/Ho_Chi_Minh',
    });
  });

  it('keeps legacy rolling-day callers compatible when period is omitted', () => {
    expect(dates({ rangeDays: 30 })).toEqual({
      from: '2026-07-12T05:30:00.000Z',
      to: '2026-08-11T05:30:00.000Z',
      fromDate: '2026-07-12',
      toDate: '2026-08-11',
      period: 'ROLLING_DAYS',
      timezone: 'Asia/Ho_Chi_Minh',
    });
  });

  it('rejects incomplete, malformed, inverted, or mixed custom windows', () => {
    expect(() => resolveAdminRevenueWindow({ period: 'CUSTOM' }, NOW)).toThrow(BadRequestException);
    expect(() =>
      resolveAdminRevenueWindow({ period: 'CUSTOM', from: '2026-02-30', to: '2026-03-01' }, NOW),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveAdminRevenueWindow({ period: 'CUSTOM', from: '2026-08-12', to: '2026-08-11' }, NOW),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveAdminRevenueWindow({ period: 'THIS_YEAR', from: '2026-01-01', to: '2026-01-02' }, NOW),
    ).toThrow(BadRequestException);
  });
});
