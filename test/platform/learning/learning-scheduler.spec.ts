import {
  scheduleLearningModules,
  type SchedulableLearningModule,
} from '../../../src/platform/learning/learning-scheduler';

const modules: SchedulableLearningModule[] = [
  {
    skillCanonical: 'typescript',
    displayName: 'TypeScript',
    estimatedMinutes: 60,
    systemPriority: 0.9,
    userRank: 1,
    prerequisites: ['javascript'],
  },
  {
    skillCanonical: 'javascript',
    displayName: 'JavaScript',
    estimatedMinutes: 120,
    systemPriority: 0.8,
    userRank: 2,
    prerequisites: [],
  },
];

describe('scheduleLearningModules', () => {
  it('honors prerequisites before user priority and schedules real dated sessions', () => {
    const result = scheduleLearningModules({
      modules,
      timezone: 'Asia/Ho_Chi_Minh',
      startDate: '2026-07-20',
      deadline: '2026-07-22',
      sessionMinutes: 60,
      slots: [
        { isoWeekday: 1, startTime: '19:00', durationMinutes: 60 },
        { isoWeekday: 2, startTime: '19:00', durationMinutes: 60 },
        { isoWeekday: 3, startTime: '19:00', durationMinutes: 60 },
      ],
    });

    expect(result.modules.map((module) => module.skillCanonical)).toEqual([
      'javascript',
      'typescript',
    ]);
    expect(result.sessions.map((session) => session.skillCanonical)).toEqual([
      'javascript',
      'javascript',
      'typescript',
    ]);
    expect(result.sessions.map((session) => session.scheduledStartAt.toISOString())).toEqual([
      '2026-07-20T12:00:00.000Z',
      '2026-07-21T12:00:00.000Z',
      '2026-07-22T12:00:00.000Z',
    ]);
    expect(result.deferred).toEqual([]);
  });

  it('marks remaining work deferred when the deadline has insufficient capacity', () => {
    const result = scheduleLearningModules({
      modules,
      timezone: 'Asia/Ho_Chi_Minh',
      startDate: '2026-07-20',
      deadline: '2026-07-20',
      sessionMinutes: 60,
      slots: [{ isoWeekday: 1, startTime: '19:00', durationMinutes: 60 }],
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.deferred).toEqual([
      { skillCanonical: 'javascript', remainingMinutes: 60 },
      { skillCanonical: 'typescript', remainingMinutes: 60 },
    ]);
    expect(result.modules).toEqual([
      expect.objectContaining({ skillCanonical: 'javascript', feasibility: 'DEFERRED' }),
      expect.objectContaining({ skillCanonical: 'typescript', feasibility: 'DEFERRED' }),
    ]);
  });

  it('rejects cyclic prerequisite input instead of silently producing a wrong order', () => {
    expect(() =>
      scheduleLearningModules({
        modules: [
          { ...modules[0], prerequisites: ['javascript'] },
          { ...modules[1], prerequisites: ['typescript'] },
        ],
        timezone: 'Asia/Ho_Chi_Minh',
        startDate: '2026-07-20',
        deadline: '2026-07-22',
        sessionMinutes: 60,
        slots: [{ isoWeekday: 1, startTime: '19:00', durationMinutes: 60 }],
      }),
    ).toThrow('Learning prerequisite graph contains a cycle.');
  });
});
