import { InterviewFocusArea } from '../../../src/modules/interview/interview-planner';
import {
  buildInterviewAgenda,
  decideTurn,
  filterRecognizedConcepts,
} from '../../../src/modules/interview/interview-agenda';

const fa = (over: Partial<InterviewFocusArea>): InterviewFocusArea => ({
  skill_canonical: 'react',
  display_name: 'React',
  focus_type: 'gap_probe',
  reason: 'missing required',
  difficulty: 'applied',
  template_question: 'How would you do X?',
  ...over,
});

const sumBudget = (a: { topics: { drill_budget: number }[] }): number =>
  a.topics.reduce((sum, topic) => sum + topic.drill_budget, 0);

describe('buildInterviewAgenda', () => {
  it('frames a real-interview arc with screening first, wrap last, behavioral for paid budget', () => {
    const agenda = buildInterviewAgenda({ focusAreas: [fa({})], seniority: 'mid', turnBudget: 10 });

    expect(agenda.topics[0].phase).toBe('SCREENING');
    expect(agenda.topics[agenda.topics.length - 1].phase).toBe('WRAP');
    expect(agenda.topics.some((topic) => topic.phase === 'BEHAVIORAL')).toBe(true);
  });

  it('uses the passed tier cap as turn_budget and clamps to at least four turns', () => {
    expect(buildInterviewAgenda({ focusAreas: [], seniority: 'mid', turnBudget: 10 }).turn_budget).toBe(
      10,
    );
    expect(buildInterviewAgenda({ focusAreas: [], seniority: 'mid', turnBudget: 6 }).turn_budget).toBe(
      6,
    );
    expect(buildInterviewAgenda({ focusAreas: [], seniority: 'mid', turnBudget: 2 }).turn_budget).toBe(
      4,
    );
  });

  it('enriches focus topics with what_to_probe and seed_question', () => {
    const agenda = buildInterviewAgenda({
      focusAreas: [fa({ reason: 'JD needs SSR depth', template_question: 'Explain hydration.' })],
      seniority: 'mid',
      turnBudget: 10,
    });

    const topic = agenda.topics.find((candidate) => candidate.phase === 'JD_REQUIREMENT');
    expect(topic).toMatchObject({
      what_to_probe: 'JD needs SSR depth',
      seed_question: 'Explain hydration.',
    });
  });

  it('orders focus topics by focus_type priority', () => {
    const agenda = buildInterviewAgenda({
      focusAreas: [
        fa({ skill_canonical: 'low', focus_type: 'strength_showcase' }),
        fa({ skill_canonical: 'high', focus_type: 'gap_probe' }),
      ],
      seniority: 'mid',
      turnBudget: 10,
    });

    const focus = agenda.topics.filter(
      (topic) => topic.phase === 'JD_REQUIREMENT' || topic.phase === 'SKILL_PROBE',
    );
    expect(focus[0].skill_canonical).toBe('high');
  });

  it('allocates paid 10-turn budget to two deep topics and reports uncovered topics', () => {
    const agenda = buildInterviewAgenda({
      focusAreas: ['a', 'b', 'c', 'd', 'e'].map((skill) => fa({ skill_canonical: skill })),
      seniority: 'mid',
      turnBudget: 10,
    });

    const focus = agenda.topics.filter((topic) => topic.phase === 'JD_REQUIREMENT');
    expect(focus.filter((topic) => topic.drill_budget >= 3)).toHaveLength(2);
    expect(agenda.uncovered).toHaveLength(3);
    expect(sumBudget(agenda)).toBeLessThanOrEqual(agenda.turn_budget);
  });

  it('keeps free 6-turn agenda non-negative and drops ceremony topics', () => {
    const agenda = buildInterviewAgenda({
      focusAreas: ['a', 'b', 'c', 'd', 'e'].map((skill) => fa({ skill_canonical: skill })),
      seniority: 'mid',
      turnBudget: 6,
    });

    expect(agenda.topics.some((topic) => topic.phase === 'BEHAVIORAL')).toBe(false);
    expect(agenda.topics.every((topic) => topic.drill_budget >= 1)).toBe(true);
    expect(sumBudget(agenda)).toBeLessThanOrEqual(6);
    expect(agenda.uncovered.length).toBeGreaterThanOrEqual(1);
  });

  it('stamps seniority_target on every topic and gives topics unique ids', () => {
    const agenda = buildInterviewAgenda({
      focusAreas: [fa({}), fa({ skill_canonical: 'react' })],
      seniority: 'senior',
      turnBudget: 10,
    });

    expect(agenda.topics.every((topic) => topic.seniority_target === 'senior')).toBe(true);
    expect(new Set(agenda.topics.map((topic) => topic.id)).size).toBe(agenda.topics.length);
  });
});

const baseTurn = {
  signal: 'shallow' as const,
  drill_depth: 0,
  drill_budget: 3,
  turns_used: 2,
  turn_budget: 10,
  evasive_streak: 0,
  seniority_target: 'senior',
};

describe('decideTurn', () => {
  it('drills deeper when shallow or adequate and budget remains', () => {
    expect(decideTurn({ ...baseTurn, signal: 'shallow' })).toBe('drill');
    expect(decideTurn({ ...baseTurn, signal: 'adequate' })).toBe('drill');
  });

  it('pushes harder after a deep senior answer before topic depth is exhausted', () => {
    expect(decideTurn({ ...baseTurn, signal: 'deep', drill_depth: 0, drill_budget: 3 })).toBe(
      'push_harder',
    );
  });

  it('advances on a strong fresher answer', () => {
    expect(decideTurn({ ...baseTurn, signal: 'deep', seniority_target: 'fresher' })).toBe(
      'advance',
    );
  });

  it('advances on a strong answer once past half-depth', () => {
    expect(decideTurn({ ...baseTurn, signal: 'deep', drill_depth: 2, drill_budget: 4 })).toBe(
      'advance',
    );
  });

  it('advances at drill_depth = drill_budget - 1', () => {
    expect(decideTurn({ ...baseTurn, drill_depth: 2, drill_budget: 3 })).toBe('advance');
  });

  it('advances after repeated evasive answers or one mid-topic dodge', () => {
    expect(decideTurn({ ...baseTurn, signal: 'evasive', evasive_streak: 2 })).toBe('advance');
    expect(decideTurn({ ...baseTurn, signal: 'evasive', drill_depth: 1, evasive_streak: 1 })).toBe(
      'advance',
    );
  });

  it('wraps near the budget and at a topic boundary with reserve two', () => {
    expect(decideTurn({ ...baseTurn, turns_used: 9, turn_budget: 10 })).toBe('wrap');
    expect(decideTurn({ ...baseTurn, turns_used: 8, turn_budget: 10, drill_depth: 0 })).toBe(
      'wrap',
    );
  });
});

describe('filterRecognizedConcepts', () => {
  it('drops a concept the answer never mentioned and keeps one it did', () => {
    expect(
      filterRecognizedConcepts(
        ['useEffect', 'useRef'],
        'I use useEffect with an empty dependency array',
      ),
    ).toEqual(['useEffect']);
  });

  it('is case-insensitive', () => {
    expect(filterRecognizedConcepts(['useEffect'], 'i USE useeffect here')).toEqual(['useEffect']);
  });

  it('keeps a concept matched via an alias the candidate used', () => {
    expect(
      filterRecognizedConcepts(['memoization'], 'I wrap it in useMemo', {
        memoization: ['useMemo'],
      }),
    ).toEqual(['memoization']);
  });

  it('does not match short concepts embedded inside unrelated words', () => {
    expect(filterRecognizedConcepts(['go', 'sql'], 'The work is ongoing and consequential')).toEqual(
      [],
    );
  });

  it('matches multi-token concepts only as adjacent whole tokens', () => {
    expect(filterRecognizedConcepts(['react query'], 'I used React Query for server state')).toEqual([
      'react query',
    ]);
    expect(filterRecognizedConcepts(['react query'], 'I used React and later wrote a query')).toEqual(
      [],
    );
  });

  it('drops everything when the answer is empty', () => {
    expect(filterRecognizedConcepts(['useEffect', 'closures'], '')).toEqual([]);
  });
});
