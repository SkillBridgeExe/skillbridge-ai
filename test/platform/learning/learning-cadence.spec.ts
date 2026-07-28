import {
  buildStudyWeekdays,
  scheduleLearningCadence,
} from '../../../src/platform/learning/learning-cadence';

describe('learning cadence', () => {
  it.each([
    [1, [1]],
    [2, [1, 4]],
    [3, [1, 3, 5]],
    [4, [1, 3, 5, 7]],
    [5, [1, 2, 4, 5, 7]],
    [6, [1, 2, 3, 4, 5, 6]],
    [7, [1, 2, 3, 4, 5, 6, 7]],
  ] as const)('distributes %i study days from the start weekday', (daysPerWeek, expected) => {
    expect(buildStudyWeekdays('2026-08-03', daysPerWeek)).toEqual(expected);
  });

  it('anchors the first unit to start_date and derives completion from the final unit', () => {
    const result = scheduleLearningCadence({
      modules: [
        {
          skillCanonical: 'html',
          displayName: 'HTML',
          estimatedMinutes: 240,
          systemPriority: 1,
          prerequisites: [],
        },
      ],
      timezone: 'Asia/Ho_Chi_Minh',
      startDate: '2026-08-03',
      studyDaysPerWeek: 3,
      sessionMinutes: 60,
    });

    expect(result.sessions.map((session) => session.scheduledStartAt.toISOString())).toEqual([
      '2026-08-03T05:00:00.000Z',
      '2026-08-05T05:00:00.000Z',
      '2026-08-07T05:00:00.000Z',
      '2026-08-10T05:00:00.000Z',
    ]);
    expect(result.estimatedCompletionDate).toBe('2026-08-10');
    expect(result.scheduledMinutes).toBe(240);
  });

  it('rejects invalid cadence instead of silently creating an infinite projection', () => {
    expect(() =>
      scheduleLearningCadence({
        modules: [],
        timezone: 'Asia/Ho_Chi_Minh',
        startDate: '2026-08-03',
        studyDaysPerWeek: 0,
        sessionMinutes: 60,
      }),
    ).toThrow('studyDaysPerWeek must be between 1 and 7');
  });
});
