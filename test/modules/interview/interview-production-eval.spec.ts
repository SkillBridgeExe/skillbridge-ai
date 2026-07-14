import {
  InterviewProductionCase,
  ProductionTurnCase,
  scoreInterviewProductionCase,
} from '../../../src/modules/interview/interview-production-eval';

/**
 * TDD spec for the Wave I-TRUST production eval scorer. The scorer composes the EXISTING pure
 * pieces (analyzeAnswerSignals → groundAnswerInsight → decideTurn → deriveInterviewGaps →
 * aggregateInterviewScore) over a corpus case and reports every mismatch — no LLM, no IO.
 */

const STRONG_ANSWER =
  'When our checkout page was slow during peak traffic, I was responsible for the performance work. ' +
  'I implemented a Redis caching layer and added a database index. As a result we reduced p99 latency by 30%.';

const SHALLOW_ANSWER = 'I think React is a library for components. I have only tried it in class.';

function turn(over: Partial<ProductionTurnCase>): ProductionTurnCase {
  return {
    question: 'Tell me about your React experience.',
    answer: SHALLOW_ANSWER,
    topic_phase: 'SKILL_PROBE',
    skill_canonical: 'react',
    display_name: 'React',
    jd_terms: ['React'],
    depth_signal: 'shallow',
    score: 45,
    drill_depth: 0,
    drill_budget: 3,
    expected_decision: 'drill',
    ...over,
  };
}

function baseCase(over: Partial<InterviewProductionCase>): InterviewProductionCase {
  return {
    id: 'spec-case',
    locale: 'en',
    target_role: 'frontend_engineer',
    seniority: 'fresher',
    cv_summary: 'Fresher CV with a class React project.',
    jd_summary: 'Frontend engineer role using React.',
    turn_budget: 8,
    turns: [turn({})],
    expected_final_gaps: [],
    ...over,
  };
}

describe('scoreInterviewProductionCase — turn decisions', () => {
  it('passes when decideTurn matches the expected decision', () => {
    const out = scoreInterviewProductionCase(baseCase({}));
    expect(out.mismatches).toEqual([]);
    expect(out.pass).toBe(true);
  });

  it('fails with a turn-indexed mismatch when the decision differs', () => {
    const out = scoreInterviewProductionCase(
      baseCase({ turns: [turn({ expected_decision: 'advance' })] }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toMatch(/turn 1.*decision.*drill.*advance/);
  });

  it('accepts any decision listed in accept_decisions', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [turn({ expected_decision: 'advance', accept_decisions: ['drill'] })],
      }),
    );
    expect(out.pass).toBe(true);
  });

  it('handles "I do not know" fairly: one follow-up at depth 0, advance at depth 1', () => {
    const idk = 'I do not know much about that topic yet, sorry.';
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            answer: idk,
            depth_signal: 'evasive',
            drill_depth: 0,
            drill_budget: 2,
            expected_decision: 'drill',
          }),
          turn({
            answer: idk,
            depth_signal: 'evasive',
            drill_depth: 1,
            drill_budget: 2,
            evasive_streak: 1,
            expected_decision: 'advance',
          }),
        ],
      }),
    );
    expect(out.mismatches).toEqual([]);
  });

  it('wraps when the turn budget is exhausted', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [turn({ turns_used: 7, expected_decision: 'wrap' })],
      }),
    );
    expect(out.pass).toBe(true);
  });
});

describe('scoreInterviewProductionCase — deterministic answer flags', () => {
  it('checks expected flags against Layer-1 signals', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            expected_flags: ['missing_example', 'hedging_present'],
            forbidden_flags: ['quantified'],
          }),
        ],
      }),
    );
    expect(out.mismatches).toEqual([]);
  });

  it('fails when an expected flag did not fire and when a forbidden flag fired', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({ answer: STRONG_ANSWER, expected_flags: ['missing_example'] }),
          turn({ answer: STRONG_ANSWER, drill_depth: 1, forbidden_flags: ['quantified'] }),
        ],
      }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toContain('missing_example');
    expect(out.mismatches.join(' ')).toContain('quantified');
  });

  it('respects the case locale: Vietnamese filler fires only under vi tables', () => {
    const viAnswer =
      'Kiểu như em có học qua, kiểu như cũng hiểu sơ sơ, đại loại là em chưa đi làm thật, kiểu như mới học thôi ạ.';
    const out = scoreInterviewProductionCase(
      baseCase({
        locale: 'vi',
        turns: [turn({ answer: viAnswer, expected_flags: ['filler_high'] })],
      }),
    );
    expect(out.mismatches).toEqual([]);
  });

  it('rejects an unsupported locale', () => {
    const out = scoreInterviewProductionCase(
      baseCase({ locale: 'fr' as InterviewProductionCase['locale'] }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toContain('locale');
  });
});

describe('scoreInterviewProductionCase — final gaps', () => {
  it('passes when every required gap is emitted (subset check)', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        expected_final_gaps: [{ weakness_type: 'evidence_gap', skill_canonical: 'react' }],
      }),
    );
    expect(out.mismatches).toEqual([]);
  });

  it('fails when a required gap is missing', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [turn({ answer: STRONG_ANSWER, jd_terms: ['Redis'] })],
        expected_final_gaps: [{ weakness_type: 'knowledge_gap', skill_canonical: 'react' }],
      }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toContain('knowledge_gap');
  });

  it('fails when a forbidden gap is emitted', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        forbidden_gaps: [{ weakness_type: 'evidence_gap', skill_canonical: 'react' }],
      }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toMatch(/forbidden.*evidence_gap/);
  });
});

describe('scoreInterviewProductionCase — forbidden claims', () => {
  it('fails when engine-side narration carries a globally forbidden claim', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            model_output: {
              talking_point: 'skill',
              relevance: 50,
              clarity: 'adequate',
              off_topic: false,
              confidence_tone: 'calibrated',
              note: 'The answer shows personality problems.',
              has_specific_example: false,
              star_present: { situation: false, task: false, action: false, result: false },
            },
          }),
        ],
      }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toContain('personality');
  });

  it('does NOT flag candidate quotes: forbidden terms in the answer itself are allowed', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({ answer: 'I think my personality fits the team but I only tried React in class.' }),
        ],
      }),
    );
    expect(out.pass).toBe(true);
  });

  it('scans case-level forbidden_claims too', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        forbidden_claims: ['strengthen react'],
        expected_final_gaps: [{ weakness_type: 'knowledge_gap', skill_canonical: 'react' }],
        turns: [
          turn({ jd_terms: ['React', 'Redux', 'GraphQL'], answer: 'I only know React a bit.' }),
        ],
      }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toContain('strengthen react');
  });
});

describe('scoreInterviewProductionCase — score bands', () => {
  it('fails when a labeled per-turn score is outside its expected band', () => {
    const out = scoreInterviewProductionCase(
      baseCase({ turns: [turn({ score: 90, expected_score_band: [30, 60] })] }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toMatch(/turn 1.*score/);
  });

  it('checks the aggregated overall against expected_overall_band', () => {
    const ok = scoreInterviewProductionCase(baseCase({ expected_overall_band: [40, 50] }));
    expect(ok.mismatches).toEqual([]);
    expect(ok.overall).toBeGreaterThanOrEqual(40);
    expect(ok.overall).toBeLessThanOrEqual(50);

    const bad = scoreInterviewProductionCase(baseCase({ expected_overall_band: [80, 90] }));
    expect(bad.pass).toBe(false);
    expect(bad.mismatches.join(' ')).toContain('overall');
  });
});

describe('scoreInterviewProductionCase — I-CONSIST consistency guard', () => {
  it('caps an evasive-but-high labeled score and requires the cap to be declared', () => {
    const undeclared = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            depth_signal: 'evasive',
            score: 90,
            expected_decision: 'drill',
            expected_score_band: [55, 65],
          }),
        ],
      }),
    );
    expect(undeclared.pass).toBe(false);
    expect(undeclared.mismatches.join(' ')).toContain('score_capped_evasive');

    const declared = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            depth_signal: 'evasive',
            score: 90,
            expected_decision: 'drill',
            expected_caps: ['score_capped_evasive'],
            expected_score_band: [55, 65],
          }),
        ],
      }),
    );
    expect(declared.mismatches).toEqual([]);
    expect(declared.pass).toBe(true);
  });

  it('caps an off-topic answer at the poor ceiling and aggregates the reconciled score', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            score: 78,
            depth_signal: 'adequate',
            insight: { off_topic: true },
            expected_decision: 'drill',
            expected_caps: ['score_capped_off_topic'],
            expected_score_band: [35, 45],
          }),
        ],
        expected_overall_band: [35, 45],
      }),
    );
    expect(out.mismatches).toEqual([]);
    expect(out.overall).toBeLessThanOrEqual(40);
  });

  it('fails the case when a declared cap does not fire (stale corpus label)', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            score: 45,
            depth_signal: 'shallow',
            expected_caps: ['score_capped_shallow'],
          }),
        ],
      }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toMatch(/caps \[\] != expected \[score_capped_shallow\]/);
  });
});

describe('scoreInterviewProductionCase — I-INTEL concept anchoring', () => {
  const REDIS_ANSWER =
    'We put a Redis cache in front of the report queries with a five minute TTL, and I added a Kafka consumer that invalidates entries on writes.';

  it('picks the grounded concept as the drill anchor and never re-drills it', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            answer: REDIS_ANSWER,
            depth_signal: 'adequate',
            recognized_concepts: ['Redis cache', 'Kafka consumer', 'not in the answer'],
            expected_decision: 'drill',
            expected_anchor: 'Redis cache',
          }),
          turn({
            answer: REDIS_ANSWER,
            depth_signal: 'adequate',
            drill_depth: 1,
            recognized_concepts: ['Redis cache', 'Kafka consumer'],
            expected_decision: 'drill',
            expected_anchor: 'Kafka consumer',
          }),
        ],
      }),
    );
    expect(out.mismatches).toEqual([]);
  });

  it('fails the case when the code picks a different anchor than labeled', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            answer: REDIS_ANSWER,
            recognized_concepts: ['Redis cache'],
            expected_decision: 'drill',
            expected_anchor: 'Kafka consumer',
          }),
        ],
      }),
    );
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toMatch(/anchor Redis cache != expected Kafka consumer/);
  });

  it('expects null anchor on a vague answer (nothing concrete to anchor on)', () => {
    const out = scoreInterviewProductionCase(
      baseCase({
        turns: [
          turn({
            answer:
              'I usually just try things until they work and read whatever docs I can find about it.',
            jd_terms: ['Redis'],
            expected_decision: 'drill',
            expected_anchor: null,
          }),
        ],
      }),
    );
    expect(out.mismatches).toEqual([]);
  });
});
