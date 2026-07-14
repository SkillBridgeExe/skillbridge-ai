import { planRoadmapSchedule } from '../../../src/modules/roadmap/schedule-planner';
import { ComposedRoadmapStep } from '../../../src/modules/roadmap/roadmap-composer';

const step = (
  skill: string,
  estimatedHours: number,
  sourceId = 'source-1',
): ComposedRoadmapStep => ({
  skill_canonical: skill,
  display_name: skill,
  strategy: 'crash_prep',
  estimated_hours: estimatedHours,
  priority: 0.7,
  resources: [],
  source_refs: [
    {
      type: 'role_baseline',
      id: sourceId,
      reason: 'Role baseline gap.',
    },
  ],
});

describe('planRoadmapSchedule', () => {
  it('bundles small related skills into one session when they fit the session duration', () => {
    const sessions = planRoadmapSchedule(
      [step('html', 0.4), step('css', 0.4), step('react', 2)],
      { minutes_per_session: 120, sessions_per_week: 10, study_days_per_week: 5 },
    );

    expect(sessions[0]).toMatchObject({
      mode: 'bundled_skills',
      title: 'html + css',
      skill_canonicals: ['html', 'css'],
      primary_skill: 'html',
      duration_minutes: 120,
    });
    expect(sessions[1]).toMatchObject({
      mode: 'single_skill',
      skill_canonicals: ['react'],
    });
  });

  it('interleaves long skills and places two 2-hour modules on each study day for a 4h/day budget', () => {
    const sessions = planRoadmapSchedule(
      [step('typescript', 4), step('react', 4)],
      { minutes_per_session: 120, sessions_per_week: 10, study_days_per_week: 5 },
    );

    expect(sessions.map((session) => session.title)).toEqual([
      'typescript 1/2',
      'react 1/2',
      'typescript 2/2',
      'react 2/2',
    ]);
    expect(sessions.map((session) => session.suggested_day_of_week)).toEqual([1, 1, 2, 2]);
    expect(sessions.map((session) => session.lane_index)).toEqual([0, 1, 0, 1]);
  });

  it('places three 2-hour modules on each study day for a 6h/day budget', () => {
    const sessions = planRoadmapSchedule(
      [step('typescript', 4), step('react', 4), step('nextjs', 4)],
      { minutes_per_session: 120, sessions_per_week: 15, study_days_per_week: 5 },
    );

    expect(sessions.map((session) => session.title).slice(0, 6)).toEqual([
      'typescript 1/2',
      'react 1/2',
      'nextjs 1/2',
      'typescript 2/2',
      'react 2/2',
      'nextjs 2/2',
    ]);
    expect(sessions.map((session) => session.suggested_day_of_week).slice(0, 6)).toEqual([
      1,
      1,
      1,
      2,
      2,
      2,
    ]);
    expect(sessions.map((session) => session.lane_index).slice(0, 6)).toEqual([
      0,
      1,
      2,
      0,
      1,
      2,
    ]);
  });

  it('does not spend multiple same-day lanes on the same long skill', () => {
    const sessions = planRoadmapSchedule(
      [step('kotlin', 6)],
      { minutes_per_session: 120, sessions_per_week: 15, study_days_per_week: 5 },
    );

    expect(sessions.map((session) => session.title)).toEqual([
      'kotlin 1/3',
      'kotlin 2/3',
      'kotlin 3/3',
    ]);
    expect(sessions.map((session) => session.suggested_day_of_week)).toEqual([1, 2, 3]);
  });

  it('starts the next ordered skill in a lane after the current skill finishes', () => {
    const sessions = planRoadmapSchedule(
      [step('typescript', 2), step('react', 4), step('nextjs', 4), step('testing', 2)],
      { minutes_per_session: 120, sessions_per_week: 15, study_days_per_week: 5 },
    );

    expect(sessions.map((session) => `${session.suggested_day_of_week}:${session.title}`)).toEqual([
      '1:typescript',
      '1:react 1/2',
      '1:nextjs 1/2',
      '2:testing',
      '2:react 2/2',
      '2:nextjs 2/2',
    ]);
  });

  it('keeps a long skill in its lane while replacing finished lanes with the next selected skills', () => {
    const sessions = planRoadmapSchedule(
      [
        step('swift', 8),
        step('kotlin', 2),
        step('java', 2),
        step('flutter', 2),
        step('websocket', 2),
      ],
      { minutes_per_session: 120, sessions_per_week: 10, study_days_per_week: 5 },
    );

    expect(sessions.map((session) => `${session.suggested_day_of_week}:${session.title}`)).toEqual([
      '1:swift 1/4',
      '1:kotlin',
      '2:swift 2/4',
      '2:java',
      '3:swift 3/4',
      '3:flutter',
      '4:swift 4/4',
      '4:websocket',
    ]);
    expect(sessions.map((session) => session.lane_index)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });
});
