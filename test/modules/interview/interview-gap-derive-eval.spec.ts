import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreGapDeriveCase,
  GapDeriveCase,
} from '../../../src/modules/interview/interview-gap-derive-eval';

describe('scoreGapDeriveCase', () => {
  it('passes when the emitted (weakness, skill) set and severity bands match', () => {
    const c: GapDeriveCase = {
      id: 'jd-miss-knowledge',
      contexts: [
        {
          topic_phase: 'SKILL_PROBE',
          skill_canonical: 'react',
          display_name: 'React',
          linked_question_id: 'q1',
          answer: 'I mostly wrote plain CSS for the marketing pages and not much else honestly.',
          jd_terms: ['React', 'Hooks', 'Context'],
          language: 'en',
        },
      ],
      // a no-concrete jd-miss skill answer emits BOTH a knowledge_gap AND an evidence_gap.
      expect: [
        { weakness_type: 'knowledge_gap', skill_canonical: 'react', severity_min: 0.5 },
        { weakness_type: 'evidence_gap', skill_canonical: 'react' },
      ],
    };
    const out = scoreGapDeriveCase(c);
    expect(out.pass).toBe(true);
    expect(out.mismatches).toEqual([]);
  });

  it('fails when an expected gap is missing', () => {
    const c: GapDeriveCase = {
      id: 'clean-but-expects-gap',
      contexts: [
        {
          topic_phase: 'SKILL_PROBE',
          skill_canonical: 'react',
          display_name: 'React',
          linked_question_id: 'q1',
          answer:
            'When checkout was slow I implemented Redis caching and reduced p99 latency by 30% for users.',
          jd_terms: ['Redis'],
          language: 'en',
        },
      ],
      expect: [{ weakness_type: 'knowledge_gap', skill_canonical: 'react' }],
    };
    const out = scoreGapDeriveCase(c);
    expect(out.pass).toBe(false);
    expect(out.mismatches.length).toBeGreaterThan(0);
  });

  it('fails when an unexpected gap is emitted', () => {
    const c: GapDeriveCase = {
      id: 'expects-none-but-emits',
      contexts: [
        {
          topic_phase: 'SKILL_PROBE',
          skill_canonical: 'react',
          display_name: 'React',
          linked_question_id: 'q1',
          answer: 'I just used React on the page here for the team really.',
          jd_terms: ['React'],
          language: 'en',
        },
      ],
      expect: [],
    };
    const out = scoreGapDeriveCase(c);
    expect(out.pass).toBe(false);
  });

  it('fails when a severity falls outside the band', () => {
    const c: GapDeriveCase = {
      id: 'severity-band-miss',
      contexts: [
        {
          topic_phase: 'SKILL_PROBE',
          skill_canonical: 'react',
          display_name: 'React',
          linked_question_id: 'q1',
          answer: 'I worked with React a bit but did not touch the rest of that stack at all.',
          jd_terms: ['React', 'Redux', 'GraphQL', 'Kafka', 'Terraform'],
          language: 'en',
        },
      ],
      // actual knowledge severity is 0.8; demand <= 0.5 → fail
      expect: [{ weakness_type: 'knowledge_gap', skill_canonical: 'react', severity_max: 0.5 }],
    };
    const out = scoreGapDeriveCase(c);
    expect(out.pass).toBe(false);
  });
});

describe('interview-gap-derive golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'interview-gap-derive-golden.json'), 'utf8'),
  ) as { cases: GapDeriveCase[] };

  it('has >=10 well-formed cases', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of golden.cases) {
      expect(c.id).toBeTruthy();
      expect(Array.isArray(c.contexts)).toBe(true);
      expect(c.contexts.length).toBeGreaterThan(0);
      expect(Array.isArray(c.expect)).toBe(true);
    }
  });

  it('covers the review-mandated scenarios (clean-none, knowledge, evidence, overclaim, comms, behavioral, technical-no-STAR, dedup, mixed, masked)', () => {
    const ids = new Set(golden.cases.map((c) => c.id));
    // a clean answer expecting NO gaps
    expect(golden.cases.some((c) => c.expect.length === 0)).toBe(true);
    // each weakness type appears in at least one case's expectation
    const weaknesses = new Set(golden.cases.flatMap((c) => c.expect.map((e) => e.weakness_type)));
    expect(weaknesses.has('knowledge_gap')).toBe(true);
    expect(weaknesses.has('evidence_gap')).toBe(true);
    expect(weaknesses.has('communication_gap')).toBe(true);
    expect(weaknesses.has('behavioral_gap')).toBe(true);
    // an overclaim case pinning evidence severity in the 0.8 band
    expect(
      golden.cases.some((c) =>
        c.expect.some(
          (e) =>
            e.weakness_type === 'evidence_gap' &&
            (e.severity_min ?? 0) >= 0.7 &&
            (e.severity_max ?? 1) <= 0.9,
        ),
      ),
    ).toBe(true);
    // a technical-no-STAR case that expects NO behavioral_gap
    const techNoStar = golden.cases.find((c) =>
      /technical.*no.*star|no.*star.*technical/i.test(c.id),
    );
    expect(techNoStar).toBeDefined();
    expect(techNoStar!.expect.some((e) => e.weakness_type === 'behavioral_gap')).toBe(false);
    // a dedup case (>= 2 contexts on the same skill, one expected gap of that type)
    expect(ids.has('dedup-same-skill')).toBe(true);
    // a masked-evidence case
    expect(golden.cases.some((c) => c.contexts.some((ctx) => /@|\d{9,}/.test(ctx.answer)))).toBe(
      true,
    );
  });

  it('every golden case PASSES its own expectation (self-consistent)', () => {
    for (const c of golden.cases) {
      const out = scoreGapDeriveCase(c);
      if (!out.pass) {
        throw new Error(`golden case ${c.id} failed: ${out.mismatches.join(', ')}`);
      }
      expect(out.pass).toBe(true);
    }
  });
});
