import { analyzeAnswerSignals } from '../../../src/modules/interview/answer-analyzer';
import { groundAnswerInsight, AnswerInsight } from '../../../src/modules/interview/answer-insight';
import { InterviewPhase } from '../../../src/modules/interview/interview-agenda';
import { groundInterviewGaps } from '../../../src/modules/interview/interview-gap';
import {
  deriveInterviewGaps,
  AnswerGapContext,
} from '../../../src/modules/interview/interview-gap-derive';

/**
 * Build a self-consistent context: signals are derived from the real Layer-1 analyzer over `answer`,
 * insight is grounded from `modelOutput` over those signals. Overrides let a test pin an insight
 * field (e.g. force off_topic / clarity) without fighting the heuristics.
 */
function ctx(over: {
  topic_phase: InterviewPhase;
  skill_canonical?: string | null;
  display_name?: string;
  linked_question_id?: string;
  answer: string;
  jd_terms?: string[];
  insight?: Partial<AnswerInsight>;
  modelOutput?: unknown;
}): AnswerGapContext {
  const signals = analyzeAnswerSignals({
    answer: over.answer,
    jd_terms: over.jd_terms ?? [],
    language: 'en',
  });
  const insight: AnswerInsight = {
    ...groundAnswerInsight(over.modelOutput ?? null, signals),
    ...over.insight,
  };
  return {
    topic_phase: over.topic_phase,
    skill_canonical: over.skill_canonical ?? null,
    display_name: over.display_name ?? 'React',
    linked_question_id: over.linked_question_id ?? 'q1',
    answer_excerpt: over.answer,
    signals,
    insight,
  };
}

const STRONG_ANSWER =
  'When our checkout page was slow during peak traffic, I was responsible for the performance work. ' +
  'I implemented a Redis caching layer and added a database index. As a result we reduced p99 latency by 30%.';

describe('deriveInterviewGaps — knowledge_gap', () => {
  it('fires ONE skill-level knowledge_gap when jd coverage < 0.5 with missed terms', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        display_name: 'React',
        answer:
          'I mostly wrote some plain CSS for the marketing pages, nothing else really honestly.',
        jd_terms: ['React', 'Hooks', 'Context'],
      }),
    ]);
    const knowledge = out.filter((g) => g.weakness_type === 'knowledge_gap');
    expect(knowledge).toHaveLength(1);
    expect(knowledge[0].target_type).toBe('skill');
    expect(knowledge[0].skill_canonical).toBe('react');
    // coverage 0 → severity clamp01(1 - 0) = 1
    expect(knowledge[0].severity).toBeCloseTo(1, 5);
    // single item cites the missed terms rather than one item per term
    expect(knowledge[0].recommended_action).toMatch(/React/);
  });

  it('coverage 0.2 → knowledge_gap severity 0.8', () => {
    // 1 of 5 jd terms hit → coverage 0.2 → severity 0.8
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'JD_REQUIREMENT',
        skill_canonical: 'react',
        answer: 'I worked with React a bit but did not touch the rest of that stack at all.',
        jd_terms: ['React', 'Redux', 'GraphQL', 'Kafka', 'Terraform'],
      }),
    ]);
    const knowledge = out.find((g) => g.weakness_type === 'knowledge_gap');
    expect(knowledge).toBeDefined();
    expect(knowledge!.severity).toBeCloseTo(0.8, 5);
  });

  it('does NOT fire knowledge_gap when coverage >= 0.5', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer: STRONG_ANSWER + ' I used React and Redis throughout.',
        jd_terms: ['React', 'Redis'],
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'knowledge_gap')).toBe(false);
  });

  it('does NOT fire knowledge_gap outside SKILL_TOPICS (e.g. BEHAVIORAL)', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'BEHAVIORAL',
        answer: 'I once disagreed with a teammate and we did not resolve it quickly.',
        jd_terms: ['React', 'Redis', 'GraphQL'],
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'knowledge_gap')).toBe(false);
  });
});

describe('deriveInterviewGaps — evidence_gap', () => {
  it('fires evidence_gap (0.5) when no concrete example on a skill topic', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer: 'I just used React to build the page here on my own machine for the team.',
        jd_terms: ['React'],
      }),
    ]);
    const ev = out.find((g) => g.weakness_type === 'evidence_gap');
    expect(ev).toBeDefined();
    expect(ev!.target_type).toBe('evidence');
    expect(ev!.severity).toBeCloseTo(0.5, 5);
  });

  it('fires evidence_gap (0.8) when insight.evidence_quality is overclaimed', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer:
          'I am honestly the best at React and I always nail every single thing without trouble.',
        jd_terms: ['React'],
        insight: { evidence_quality: 'overclaimed' },
      }),
    ]);
    const ev = out.find((g) => g.weakness_type === 'evidence_gap');
    expect(ev).toBeDefined();
    expect(ev!.severity).toBeCloseTo(0.8, 5);
  });

  it('does NOT fire evidence_gap when a concrete example is present and quality is strong', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer: STRONG_ANSWER,
        jd_terms: ['Redis'],
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'evidence_gap')).toBe(false);
  });

  it('does NOT fire evidence_gap when evidence_quality is strong even if L1 lacks a concrete example (Q2)', () => {
    // a qualitative specific example: L2 made evidence_quality strong though there is no number/tech.
    // Old code keyed off signals.has_concrete_example and would have fired; now it flows from evidence_quality.
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer:
          'I once walked a new teammate through our code review process and it went smoothly.',
        jd_terms: [],
        insight: { evidence_quality: 'strong' },
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'evidence_gap')).toBe(false);
  });
});

describe('deriveInterviewGaps — communication_gap', () => {
  it('fires communication_gap with severity scaled by number of fired signals', () => {
    // off_topic + unclear = 2 fired (no filler, not rambling) → severity 0.6
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SCREENING',
        answer: 'I went on about a few unrelated things here and there for the most part really.',
        insight: { off_topic: true, clarity: 'unclear' },
      }),
    ]);
    const comm = out.find((g) => g.weakness_type === 'communication_gap');
    expect(comm).toBeDefined();
    expect(comm!.target_type).toBe('communication');
    expect(comm!.skill_canonical).toBeNull();
    expect(comm!.severity).toBeCloseTo(0.6, 5);
  });

  it('fires from filler count >= threshold alone', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SCREENING',
        answer:
          'Um, you know, basically, actually, I mean, like, sort of, kind of, that is roughly it here.',
        insight: { off_topic: false, clarity: 'clear' },
      }),
    ]);
    const comm = out.find((g) => g.weakness_type === 'communication_gap');
    expect(comm).toBeDefined();
  });

  it('does NOT fire communication_gap for a clean, on-topic, clear answer', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SCREENING',
        answer: STRONG_ANSWER,
        insight: { off_topic: false, clarity: 'clear' },
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'communication_gap')).toBe(false);
  });
});

describe('deriveInterviewGaps — behavioral_gap (review-locked)', () => {
  it('fires behavioral_gap when insight.star_present is incomplete on BEHAVIORAL (even if the answer is substantive with no corroborating weakness)', () => {
    // Key discriminator vs the interim corroboration gate: a long, clear, on-topic answer that
    // L2 explicitly marks STAR incomplete → MUST fire. Old corroboration gate would suppress it.
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'BEHAVIORAL',
        answer:
          'At my previous job I was asked to onboard a new team member but the documentation was outdated. ' +
          'I spent two days rewriting the setup guide and pair-programmed with them for a week.',
        // no filler, not short, clear, on-topic — corroborating weakness signals absent
        insight: {
          star_present: { situation: true, task: false, action: true, result: false },
          off_topic: false,
          clarity: 'clear',
        },
      }),
    ]);
    const beh = out.find((g) => g.weakness_type === 'behavioral_gap');
    expect(beh).toBeDefined();
    expect(beh!.target_type).toBe('behavioral');
    expect(beh!.severity).toBeGreaterThan(0);
    expect(beh!.recommended_action).toMatch(/STAR/i);
  });

  it('does NOT fire behavioral_gap when insight.star_present is complete (all true), even if the answer is short/rambling', () => {
    // Key discriminator: short, rambling answer (old gate would fire based on corroboration),
    // but L2 says all STAR parts present → must NOT fire.
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'BEHAVIORAL',
        answer: 'Um, I disagreed with someone and it was awkward honestly.',
        // L1: short + filler → corroborating weakness present — old gate WOULD fire
        insight: {
          star_present: { situation: true, task: true, action: true, result: true },
          off_topic: false,
          clarity: 'clear',
        },
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'behavioral_gap')).toBe(false);
  });

  it('does NOT fire behavioral_gap on a short SKILL_PROBE answer that lacks STAR (review rule)', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer: 'React re-renders when state changes.',
        jd_terms: ['React'],
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'behavioral_gap')).toBe(false);
  });

  it('does NOT fire behavioral_gap on a JD_REQUIREMENT answer that lacks STAR', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'JD_REQUIREMENT',
        skill_canonical: 'react',
        answer: 'I would set up a CI pipeline and add tests for the critical path here.',
        jd_terms: ['React'],
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'behavioral_gap')).toBe(false);
  });

  it('CAN fire behavioral_gap on SCENARIO when insight.star_present is incomplete', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SCENARIO',
        skill_canonical: 'react',
        answer: 'I would probably just try a few things and see what sticks honestly.',
        jd_terms: ['React'],
        insight: { star_present: { situation: true, task: false, action: false, result: false } },
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'behavioral_gap')).toBe(true);
  });

  it('does NOT fire behavioral_gap on BEHAVIORAL when insight.star_present is complete (all true)', () => {
    // Regression: even if the answer phrasing would fool L1 cue-matching, L2 complete → no gap.
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'BEHAVIORAL',
        answer:
          'At my previous job I disagreed with my manager over the technology stack. I requested a meeting and prepared a comparison of both approaches, then presented my findings. After discussion the team adopted a hybrid approach and it produced a more maintainable solution.',
        insight: {
          star_present: { situation: true, task: true, action: true, result: true },
          off_topic: false,
          clarity: 'clear',
        },
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'behavioral_gap')).toBe(false);
  });
});

describe('deriveInterviewGaps — role_fit_risk is NOT derived here', () => {
  it('never emits role_fit_risk', () => {
    const out = deriveInterviewGaps([
      ctx({ topic_phase: 'BEHAVIORAL', answer: 'Short and vague.' }),
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer: 'I just used React here.',
        jd_terms: ['React', 'Redux'],
      }),
    ]);
    expect(out.some((g) => g.weakness_type === 'role_fit_risk')).toBe(false);
  });
});

describe('deriveInterviewGaps — bounding, dedup, masking, grounding', () => {
  it('strong answer with full coverage → NO gaps', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer: STRONG_ANSWER + ' I used React and Redis throughout.',
        jd_terms: ['React', 'Redis'],
        insight: { off_topic: false, clarity: 'clear' },
      }),
    ]);
    expect(out).toEqual([]);
  });

  it('dedups two contexts on the same skill+weakness to one item, keeping MAX severity', () => {
    const weak = ctx({
      topic_phase: 'SKILL_PROBE',
      skill_canonical: 'react',
      display_name: 'React',
      answer: 'I just used React on the page here for the team really.',
      jd_terms: ['React'],
    });
    const weaker = ctx({
      topic_phase: 'SKILL_PROBE',
      skill_canonical: 'react',
      display_name: 'React',
      linked_question_id: 'q2',
      answer: 'I am the best at React and always nail it without trouble at all every time.',
      jd_terms: ['React'],
      insight: { evidence_quality: 'overclaimed' },
    });
    const out = deriveInterviewGaps([weak, weaker]);
    const ev = out.filter((g) => g.weakness_type === 'evidence_gap');
    expect(ev).toHaveLength(1);
    // overclaimed (0.8) beats thin (0.5)
    expect(ev[0].severity).toBeCloseTo(0.8, 5);
  });

  it('masks email/phone PII in evidence_from_answer', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer: 'Reach me at john@acme.com or 0912345678. I just used React on the page here.',
        jd_terms: ['React'],
      }),
    ]);
    expect(out.length).toBeGreaterThan(0);
    for (const g of out) {
      expect(g.evidence_from_answer).not.toContain('john@acme.com');
      expect(g.evidence_from_answer).not.toContain('0912345678');
      expect(g.evidence_from_answer).toContain('[redacted-email]');
    }
  });

  it('truncates evidence_from_answer to <= 280 chars', () => {
    const long = 'I just used React on the page. ' + 'word '.repeat(120);
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SKILL_PROBE',
        skill_canonical: 'react',
        answer: long,
        jd_terms: ['React', 'Redux'],
      }),
    ]);
    for (const g of out) {
      expect(g.evidence_from_answer.length).toBeLessThanOrEqual(280);
    }
  });

  it('every emitted item survives groundInterviewGaps (linked_question_id + evidence + probed skill)', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SCENARIO',
        skill_canonical: 'react',
        answer: 'Um, you know, I just used React and would try a few things, not sure honestly.',
        jd_terms: ['React', 'Redux', 'GraphQL'],
        insight: { off_topic: true, clarity: 'unclear' },
      }),
    ]);
    expect(out.length).toBeGreaterThan(0);
    const kept = groundInterviewGaps(out, new Set(['react']));
    expect(kept.length).toBe(out.length);
    for (const g of out) {
      expect(g.linked_question_id).toBeTruthy();
      expect(g.evidence_from_answer.trim().length).toBeGreaterThan(0);
    }
  });

  it('sorts emitted items by severity descending', () => {
    const out = deriveInterviewGaps([
      ctx({
        topic_phase: 'SCENARIO',
        skill_canonical: 'react',
        answer: 'Um, like, you know, I just used React, not sure, would try a few things honestly.',
        jd_terms: ['React', 'Redux', 'GraphQL', 'Kafka', 'Terraform'],
        insight: { off_topic: true, clarity: 'unclear', evidence_quality: 'overclaimed' },
      }),
    ]);
    expect(out.length).toBeGreaterThan(1);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].severity).toBeGreaterThanOrEqual(out[i].severity);
    }
  });
});
