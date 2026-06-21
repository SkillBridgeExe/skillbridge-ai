/**
 * Interview chain e2e (PURE — no LLM). Proves the deterministic interview chain CLOSES:
 *
 *   analyzeAnswerSignals (L1) + a hand-built AnswerInsight (L2)
 *     → deriveInterviewGaps  (grounded InterviewGapItem[])
 *     → buildUnifiedPlan     (UnifiedDevelopmentPlan)
 *     → buildCoachingFacts   (CoachingFacts)
 *
 * The key assertion: a confident-but-NO-CONCRETE-example technical answer surfaces an
 * evidence/cv_fix priority — the exact "you claimed it but gave no proof" signal coaching exists to
 * name. Pure: every step is deterministic, there is no LLM, no IO, no NestJS DI.
 */

import { analyzeAnswerSignals } from '../../../src/modules/interview/answer-analyzer';
import { AnswerInsight } from '../../../src/modules/interview/answer-insight';
import {
  AnswerGapContext,
  deriveInterviewGaps,
} from '../../../src/modules/interview/interview-gap-derive';
import { buildUnifiedPlan } from '../../../src/modules/gap-report/unified-plan';
import { buildCoachingFacts } from '../../../src/modules/interview/interview-coaching';
import {
  InterviewScore,
  aggregateInterviewScore,
} from '../../../src/modules/interview/interview-scoring';

// An assertive React answer with NO concrete example/metric (review-locked: "I used React" is not
// a concrete example) → L1 has_concrete_example=false, plus an "over" insight tone.
const NO_CONCRETE_ANSWER =
  'I am very strong with React. I have used React a lot and I am confident I can handle anything ' +
  'they throw at me with it.';

const SIGNALS = analyzeAnswerSignals({
  answer: NO_CONCRETE_ANSWER,
  jd_terms: ['React'],
  language: 'en',
});

// Hand-built L2 insight (the LLM's job in prod) — over-confident tone, no concrete backing → the
// grounding would derive evidence_quality='overclaimed'.
const INSIGHT: AnswerInsight = {
  talking_point: 'skill',
  relevance: 70,
  clarity: 'clear',
  off_topic: false,
  confidence_tone: 'over',
  evidence_quality: 'overclaimed',
  note: 'Confident but no concrete example.',
};

const CONTEXT: AnswerGapContext = {
  topic_phase: 'SKILL_PROBE',
  skill_canonical: 'react',
  display_name: 'React',
  linked_question_id: 'q1',
  answer_excerpt: NO_CONCRETE_ANSWER,
  signals: SIGNALS,
  insight: INSIGHT,
};

describe('interview chain e2e (signals → insight → gaps → plan → facts)', () => {
  it('L1 sees no concrete example for an assertive React answer', () => {
    expect(SIGNALS.has_concrete_example).toBe(false);
  });

  it('deriveInterviewGaps surfaces an evidence_gap for the unproven React claim', () => {
    const gaps = deriveInterviewGaps([CONTEXT]);
    const evidenceGap = gaps.find((g) => g.weakness_type === 'evidence_gap');
    expect(evidenceGap).toBeDefined();
    expect(evidenceGap!.display_name).toBe('React');
    expect(evidenceGap!.skill_canonical).toBe('react');
  });

  it('buildUnifiedPlan routes the evidence_gap into the cv_fix track', () => {
    const gaps = deriveInterviewGaps([CONTEXT]);
    const plan = buildUnifiedPlan({
      matchId: 'm1',
      sessionId: 's1',
      gapItems: [],
      interviewItems: gaps,
    });
    expect(plan.cv_fix_items.some((i) => i.display_name === 'React')).toBe(true);
  });

  it('buildCoachingFacts surfaces an evidence/cv_fix priority — the chain closes', () => {
    const gaps = deriveInterviewGaps([CONTEXT]);
    const plan = buildUnifiedPlan({
      matchId: 'm1',
      sessionId: 's1',
      gapItems: [],
      interviewItems: gaps,
    });
    // a real role-weighted score from the same probed answer (deterministic).
    const score: InterviewScore = aggregateInterviewScore({
      answers: [{ topic_phase: 'SKILL_PROBE', score: 70, depth_signal: 'adequate' }],
      role: 'frontend engineer',
      seniority: 'mid',
    });

    const facts = buildCoachingFacts({ score, gaps, plan });

    // the no-concrete answer must surface a cv_fix priority targeting React evidence.
    const cvFixPriority = facts.priorities.find((p) => p.track === 'cv_fix' && p.title === 'React');
    expect(cvFixPriority).toBeDefined();

    // and the gap itself rides through to top_gaps as an evidence weakness.
    const evidenceTopGap = facts.top_gaps.find((g) => g.weakness_type === 'evidence_gap');
    expect(evidenceTopGap).toBeDefined();
    expect(evidenceTopGap!.display_name).toBe('React');
  });
});
