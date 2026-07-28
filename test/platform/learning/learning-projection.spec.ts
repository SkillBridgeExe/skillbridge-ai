import { computeLearningProjection } from '../../../src/platform/learning/learning-projection';

describe('learning projection', () => {
  it('reports PREP-style planned, missed and pace metrics from server progress', () => {
    const result = computeLearningProjection({
      cadence: {
        timezone: 'Asia/Ho_Chi_Minh',
        start_date: '2026-08-03',
        study_days_per_week: 3,
        session_minutes: 60,
      },
      sessions: [
        { id: 'session-1', scheduledStartAt: new Date('2026-08-03T05:00:00.000Z') },
        { id: 'session-2', scheduledStartAt: new Date('2026-08-05T05:00:00.000Z') },
        { id: 'session-3', scheduledStartAt: new Date('2026-08-07T05:00:00.000Z') },
        { id: 'session-4', scheduledStartAt: new Date('2026-08-10T05:00:00.000Z') },
      ],
      completedSessionIds: new Set(['session-1']),
      today: '2026-08-06',
    });

    expect(result).toEqual({
      start_date: '2026-08-03',
      estimated_completion_date: '2026-08-10',
      study_days_per_week: 3,
      session_minutes: 60,
      total_units: 4,
      completed_units: 1,
      planned_units_by_today: 2,
      missed_units: 1,
      pace_percentage: 50,
      days_remaining: 4,
    });
  });

  it('uses a neutral 100 percent pace before the first planned unit', () => {
    const result = computeLearningProjection({
      cadence: {
        timezone: 'Asia/Ho_Chi_Minh',
        start_date: '2026-08-10',
        study_days_per_week: 2,
        session_minutes: 60,
      },
      sessions: [{ id: 'session-1', scheduledStartAt: new Date('2026-08-10T05:00:00.000Z') }],
      completedSessionIds: new Set(),
      today: '2026-08-03',
    });

    expect(result.planned_units_by_today).toBe(0);
    expect(result.pace_percentage).toBe(100);
    expect(result.missed_units).toBe(0);
  });
});
