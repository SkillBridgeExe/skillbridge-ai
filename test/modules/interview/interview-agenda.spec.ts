import { InterviewFocusArea } from '../../../src/modules/interview/interview-planner';
import {
  buildInterviewAgenda,
  decideTurn,
  decideTurnWithTrace,
  drillLadderRung,
  filterGroundedGaps,
  filterRecognizedConcepts,
  isGroundedFollowUp,
  pickDrillAnchor,
  TURN_BUDGET_BY_TIER,
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
  it('frames a time-boxed interview arc with screening first and no normal wrap topic', () => {
    const agenda = buildInterviewAgenda({ focusAreas: [fa({})], seniority: 'mid', turnBudget: 10 });

    expect(agenda.topics[0].phase).toBe('SCREENING');
    expect(agenda.topics.map((topic) => topic.phase)).not.toContain('WRAP');
    expect(agenda.topics.some((topic) => topic.phase === 'BEHAVIORAL')).toBe(true);
  });

  it('uses the passed tier cap as turn_budget and clamps to at least four turns', () => {
    expect(
      buildInterviewAgenda({ focusAreas: [], seniority: 'mid', turnBudget: 10 }).turn_budget,
    ).toBe(10);
    expect(
      buildInterviewAgenda({ focusAreas: [], seniority: 'mid', turnBudget: 6 }).turn_budget,
    ).toBe(6);
    expect(
      buildInterviewAgenda({ focusAreas: [], seniority: 'mid', turnBudget: 2 }).turn_budget,
    ).toBe(4);
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

  it('allocates the paid 12-turn budget to one 4-deep lead topic plus a second topic', () => {
    const agenda = buildInterviewAgenda({
      focusAreas: ['a', 'b', 'c', 'd', 'e'].map((skill) => fa({ skill_canonical: skill })),
      seniority: 'mid',
      turnBudget: TURN_BUDGET_BY_TIER.paid,
    });

    const focus = agenda.topics.filter((topic) => topic.phase === 'JD_REQUIREMENT');
    // 12 turns, 6 reserved (screening 1 + scenario chain 3 + behavioral 1 + closing slack)
    // → 6 for skill topics: a 4-rung lead drill + a 2-question second topic.
    expect(focus.map((topic) => topic.drill_budget)).toEqual([4, 2]);
    expect(agenda.uncovered).toHaveLength(3);
    expect(sumBudget(agenda)).toBeLessThanOrEqual(agenda.turn_budget);
  });

  it('paid tier budget is 12 turns', () => {
    expect(TURN_BUDGET_BY_TIER.paid).toBe(12);
    expect(TURN_BUDGET_BY_TIER.free).toBe(6);
  });

  it('gives the scenario topic a 3-turn incident chain on paid budgets', () => {
    const agenda = buildInterviewAgenda({
      focusAreas: [fa({})],
      seniority: 'mid',
      turnBudget: TURN_BUDGET_BY_TIER.paid,
    });

    const scenario = agenda.topics.find((topic) => topic.phase === 'SCENARIO');
    expect(scenario?.drill_budget).toBe(3);
    expect(scenario?.seed_question.toLowerCase()).toContain('production');
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

  it('treats every early-career band (intern/junior/entry_level, case-insensitive) as fresher for drilling — consistent with interview-scoring (review P1-1, shared EARLY_CAREER_BANDS)', () => {
    for (const band of ['intern', 'junior', 'entry_level', 'Entry_Level']) {
      expect(decideTurn({ ...baseTurn, signal: 'deep', seniority_target: band })).toBe('advance');
    }
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

describe('drillLadderRung', () => {
  it('climbs application → tradeoff → edge_failure → design for a non-fresher', () => {
    expect(drillLadderRung(0, 'senior')).toBe('application');
    expect(drillLadderRung(1, 'senior')).toBe('tradeoff');
    expect(drillLadderRung(2, 'senior')).toBe('edge_failure');
    expect(drillLadderRung(3, 'senior')).toBe('design');
  });

  it('caps the ladder at tradeoff for early-career bands, with reflection in between', () => {
    expect(drillLadderRung(0, 'fresher')).toBe('application');
    expect(drillLadderRung(1, 'fresher')).toBe('reflection');
    expect(drillLadderRung(2, 'intern')).toBe('tradeoff');
    expect(drillLadderRung(5, 'junior')).toBe('tradeoff');
  });

  it('clamps past the end of the ladder', () => {
    expect(drillLadderRung(9, 'senior')).toBe('design');
  });

  it('overrides any depth rung with decision_ownership on a collective answer (I-OWN)', () => {
    expect(drillLadderRung(0, 'senior', { collectiveAnswer: true })).toBe('decision_ownership');
    expect(drillLadderRung(3, 'senior', { collectiveAnswer: true })).toBe('decision_ownership');
    expect(drillLadderRung(1, 'fresher', { collectiveAnswer: true })).toBe('decision_ownership');
  });

  it('falls back to the depth rung once the answer is no longer collective', () => {
    expect(drillLadderRung(1, 'senior', { collectiveAnswer: false })).toBe('tradeoff');
    expect(drillLadderRung(1, 'fresher', {})).toBe('reflection');
  });
});

describe('isGroundedFollowUp', () => {
  const context = [
    'I implemented a Redis caching layer and reduced p99 latency by 30%.',
    'Redis cache invalidation strategy',
  ];

  it('accepts a follow-up that reuses a content term from the answer/thread', () => {
    expect(isGroundedFollowUp('How did you decide the TTL for that Redis cache?', context)).toBe(
      true,
    );
    expect(isGroundedFollowUp('What breaks first if invalidation lags?', context)).toBe(true);
  });

  it('flags a generic template question that ignores the answer', () => {
    expect(isGroundedFollowUp('Tell me about your greatest strength.', context)).toBe(false);
    expect(isGroundedFollowUp('Where do you see yourself in five years?', context)).toBe(false);
  });

  it('is honest about empty inputs: no question or no context → not grounded', () => {
    expect(isGroundedFollowUp('', context)).toBe(false);
    expect(isGroundedFollowUp('How did you build the cache?', [])).toBe(false);
  });
});

describe('decideTurnWithTrace', () => {
  const traceTurn = { ...baseTurn, phase: 'JD_REQUIREMENT', topic_id: 'topic-1-react' };

  it('returns the SAME action decideTurn returns for the same input (single source of truth)', () => {
    for (const signal of ['shallow', 'adequate', 'deep', 'evasive'] as const) {
      const { action } = decideTurnWithTrace({ ...traceTurn, signal });
      expect(action).toBe(decideTurn({ ...traceTurn, signal }));
    }
  });

  it('drills a shallow answer with an explanatory reason and full trace context', () => {
    const { action, trace } = decideTurnWithTrace(traceTurn);
    expect(action).toBe('drill');
    expect(trace).toMatchObject({
      action: 'drill',
      phase: 'JD_REQUIREMENT',
      topic_id: 'topic-1-react',
      depth: 0,
      remaining_turn_budget: 8,
      confidence: 'high',
    });
    expect(trace.reasons).toContain('answer_shallow');
    expect(trace.reasons).toContain('drill_budget_available');
  });

  it('maps push_harder onto trace action drill with a push reason', () => {
    const { action, trace } = decideTurnWithTrace({ ...traceTurn, signal: 'deep' });
    expect(action).toBe('push_harder');
    expect(trace.action).toBe('drill');
    expect(trace.reasons).toContain('deep_answer_push_for_depth');
  });

  it('moves on at the drill-depth limit with the budget reason', () => {
    const { action, trace } = decideTurnWithTrace({ ...traceTurn, drill_depth: 2 });
    expect(action).toBe('advance');
    expect(trace.action).toBe('move_on');
    expect(trace.reasons).toContain('drill_budget_reached');
  });

  it('wraps when the turn budget is exhausted', () => {
    const { trace } = decideTurnWithTrace({ ...traceTurn, turns_used: 9 });
    expect(trace.action).toBe('wrap');
    expect(trace.reasons).toContain('turn_budget_exhausted');
    expect(trace.remaining_turn_budget).toBe(1);
  });

  it('gives one fair follow-up on a first evasive answer, then moves on', () => {
    const first = decideTurnWithTrace({ ...traceTurn, signal: 'evasive' });
    expect(first.action).toBe('drill');
    expect(first.trace.reasons).toContain('one_fair_follow_up');

    const second = decideTurnWithTrace({
      ...traceTurn,
      signal: 'evasive',
      drill_depth: 1,
      evasive_streak: 1,
    });
    expect(second.action).toBe('advance');
    expect(second.trace.reasons).toContain('evasive_after_follow_up');
  });

  it('explains the early-career advance on a deep answer', () => {
    const { trace } = decideTurnWithTrace({
      ...traceTurn,
      signal: 'deep',
      seniority_target: 'fresher',
    });
    expect(trace.action).toBe('move_on');
    expect(trace.reasons).toContain('deep_answer');
    expect(trace.reasons).toContain('early_career_no_push');
  });

  it('never reports a negative remaining budget', () => {
    const { trace } = decideTurnWithTrace({ ...traceTurn, turns_used: 12 });
    expect(trace.remaining_turn_budget).toBe(0);
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
    expect(
      filterRecognizedConcepts(['go', 'sql'], 'The work is ongoing and consequential'),
    ).toEqual([]);
  });

  it('matches multi-token concepts only as adjacent whole tokens', () => {
    expect(
      filterRecognizedConcepts(['react query'], 'I used React Query for server state'),
    ).toEqual(['react query']);
    expect(
      filterRecognizedConcepts(['react query'], 'I used React and later wrote a query'),
    ).toEqual([]);
  });

  it('drops everything when the answer is empty', () => {
    expect(filterRecognizedConcepts(['useEffect', 'closures'], '')).toEqual([]);
  });
});

describe('filterGroundedGaps', () => {
  const universe = [
    'How does React decide when to re-render a component?',
    'React',
    'react',
    'reconciliation and the virtual DOM',
  ];

  it('drops a fabricated off-topic gap the topic universe never mentions', () => {
    expect(filterGroundedGaps(['did not explain Kafka partitioning strategy'], universe)).toEqual(
      [],
    );
  });

  it('keeps a gap anchored to the question or agenda topic terms', () => {
    expect(
      filterGroundedGaps(
        ['did not explain Kafka partitioning strategy', 'shallow on the React reconciliation step'],
        universe,
      ),
    ).toEqual(['shallow on the React reconciliation step']);
  });

  it('grounds Vietnamese gap phrases on their ASCII tech terms', () => {
    expect(
      filterGroundedGaps(
        ['chưa giải thích được cơ chế re-render của React', 'chưa nắm vững Kafka consumer group'],
        universe,
      ),
    ).toEqual(['chưa giải thích được cơ chế re-render của React']);
  });

  it('drops assessment filler with no groundable key term', () => {
    expect(filterGroundedGaps(['did not explain the answer', ''], universe)).toEqual([]);
  });

  it('is case-insensitive like the concept filter', () => {
    expect(filterGroundedGaps(['REACT rendering was vague'], universe)).toEqual([
      'REACT rendering was vague',
    ]);
  });
});

describe('pickDrillAnchor (I-INTEL concept-anchored drilling)', () => {
  const REDIS_ANSWER =
    'We cache the report queries in Redis with a five minute TTL, and I added a Kafka consumer to invalidate entries on writes.';

  it('anchors on a grounded recognized concept first', () => {
    const out = pickDrillAnchor({
      answer: REDIS_ANSWER,
      recognized_concepts: ['Redis cache', 'Kafka consumer'],
      jd_terms: ['PostgreSQL', 'Redis'],
      probed_anchors: [],
    });
    expect(out.anchor).toBe('Redis cache');
    expect(out.candidates).toContain('Kafka consumer');
  });

  it('never re-drills a probed anchor (case-insensitive) — moves to the next candidate', () => {
    const out = pickDrillAnchor({
      answer: REDIS_ANSWER,
      recognized_concepts: ['Redis cache', 'Kafka consumer'],
      jd_terms: [],
      probed_anchors: ['redis cache'],
    });
    expect(out.anchor).toBe('Kafka consumer');
  });

  it('falls back to a JD term present in the answer, then to a named tech', () => {
    const jdFallback = pickDrillAnchor({
      answer: 'I mostly tuned the PostgreSQL indexes for the reporting tables.',
      recognized_concepts: [],
      jd_terms: ['PostgreSQL', 'Kubernetes'],
      probed_anchors: [],
    });
    expect(jdFallback.anchor).toBe('PostgreSQL');

    const techFallback = pickDrillAnchor({
      answer: 'The workers talk to each other over kafka topics.',
      recognized_concepts: [],
      jd_terms: ['GraphQL'],
      probed_anchors: [],
    });
    expect(techFallback.anchor).toBe('kafka');
  });

  it('returns null for a vague answer with nothing concrete to anchor on', () => {
    const out = pickDrillAnchor({
      answer: 'I usually just try to make things work and learn as I go, it depends a lot.',
      recognized_concepts: [],
      jd_terms: ['Redis'],
      probed_anchors: [],
    });
    expect(out.anchor).toBeNull();
    expect(out.candidates).toEqual([]);
  });

  it('ignores degenerate concepts (too short / filler-only)', () => {
    const out = pickDrillAnchor({
      answer: 'We did it in go and it was ok.',
      recognized_concepts: ['it', 'ok'],
      jd_terms: [],
      probed_anchors: [],
    });
    expect(out.anchor).toBeNull();
  });
});
