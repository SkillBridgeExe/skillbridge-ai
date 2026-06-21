import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreAnswerInsightCase,
  AnswerInsightCase,
} from '../../../src/modules/interview/answer-insight-eval';

describe('scoreAnswerInsightCase', () => {
  it('passes when the grounded insight matches the expected subset', () => {
    const c: AnswerInsightCase = {
      id: 'clamp-and-derive',
      signal_input: {
        answer:
          'When the page was slow, I implemented a Redis cache and reduced p99 latency by 30%.',
        jd_terms: ['Redis'],
        language: 'en',
      },
      model_output: {
        talking_point: 'project',
        relevance: 150,
        clarity: 'clear',
        off_topic: false,
        confidence_tone: 'calibrated',
        note: 'ok',
      },
      expect: { relevance: 100, evidence_quality: 'strong', talking_point: 'project' },
    };
    const out = scoreAnswerInsightCase(c);
    expect(out.pass).toBe(true);
    expect(out.mismatches).toEqual([]);
  });

  it('fails and names the mismatching key', () => {
    const c: AnswerInsightCase = {
      id: 'wrong-evidence',
      signal_input: { answer: 'I am not sure about that.', language: 'en' },
      model_output: { confidence_tone: 'over' },
      expect: { evidence_quality: 'strong' }, // derive gives overclaimed → mismatch
    };
    const out = scoreAnswerInsightCase(c);
    expect(out.pass).toBe(false);
    expect(out.mismatches).toContain('evidence_quality');
  });
});

describe('answer-insight grounding golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'answer-insight-golden.json'), 'utf8'),
  ) as { cases: AnswerInsightCase[] };

  it('has >=10 well-formed cases', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of golden.cases) {
      expect(c.id).toBeTruthy();
      expect(c.signal_input).toBeTruthy();
      expect(c.signal_input.language === 'vi' || c.signal_input.language === 'en').toBe(true);
      expect(c.expect).toBeTruthy();
    }
  });

  it('covers the review-mandated grounding cases', () => {
    // valid passthrough
    expect(golden.cases.some((c) => /passthrough|valid/i.test(c.id))).toBe(true);
    // invalid-enum → default
    expect(golden.cases.some((c) => c.expect.talking_point === 'experience')).toBe(true);
    // relevance clamp
    expect(golden.cases.some((c) => c.expect.relevance === 100 || c.expect.relevance === 0)).toBe(
      true,
    );
    // null output → fallback
    expect(golden.cases.some((c) => c.model_output === null)).toBe(true);
    // concrete → strong
    expect(golden.cases.some((c) => c.expect.evidence_quality === 'strong')).toBe(true);
    // overclaim (no-concrete + over) → overclaimed
    expect(golden.cases.some((c) => c.expect.evidence_quality === 'overclaimed')).toBe(true);
    // thin
    expect(golden.cases.some((c) => c.expect.evidence_quality === 'thin')).toBe(true);
    // rambling + low-relevance → off_topic true
    expect(golden.cases.some((c) => c.expect.off_topic === true)).toBe(true);
    // a VI case
    expect(golden.cases.some((c) => c.signal_input.language === 'vi')).toBe(true);
  });

  it('every golden case PASSES its own expectation (self-consistent)', () => {
    for (const c of golden.cases) {
      const out = scoreAnswerInsightCase(c);
      if (!out.pass) {
        throw new Error(`golden case ${c.id} failed: ${out.mismatches.join(', ')}`);
      }
      expect(out.pass).toBe(true);
    }
  });
});
