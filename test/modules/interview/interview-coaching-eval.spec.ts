import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreInterviewCoachingCase,
  InterviewCoachingCase,
} from '../../../src/modules/interview/interview-coaching-eval';

describe('scoreInterviewCoachingCase', () => {
  it('passes when the grounded coaching matches the expected facts', () => {
    const c: InterviewCoachingCase = {
      id: 'ok',
      facts: {
        overall: 70,
        overall_band: 'solid',
        strengths: [{ name: 'technical_depth', band: 'outstanding' }],
        priorities: [{ track: 'cv_fix', title: 'React', severity: 0.8 }],
        top_gaps: [],
      },
      model_output: { summary: 'Solid depth; add a React example.', priority_notes: ['why react'] },
      expect: {
        strengths: ['technical_depth: outstanding'],
        priority_titles: ['React'],
        summary_equals: 'Solid depth; add a React example.',
      },
    };
    const out = scoreInterviewCoachingCase(c);
    expect(out.pass).toBe(true);
    expect(out.mismatches).toEqual([]);
  });

  it('fails and names the mismatch when the model tries to fabricate a priority', () => {
    const c: InterviewCoachingCase = {
      id: 'fabricated',
      facts: {
        overall: 70,
        overall_band: 'solid',
        strengths: [],
        priorities: [{ track: 'learn', title: 'TypeScript', severity: 0.7 }],
        top_gaps: [],
      },
      model_output: {
        summary: 'ok',
        priorities: [{ track: 'learn', title: 'FAKE', why: 'x' }],
        priority_notes: ['why ts'],
      },
      // assert the WRONG (fabricated) title — grounding ignores it, so this expectation mismatches.
      expect: { priority_titles: ['FAKE'] },
    };
    const out = scoreInterviewCoachingCase(c);
    expect(out.pass).toBe(false);
    expect(out.mismatches.join(' ')).toContain('priority_titles');
  });
});

describe('interview-coaching grounding golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'interview-coaching-golden.json'), 'utf8'),
  ) as { cases: InterviewCoachingCase[] };

  it('has >=10 well-formed cases', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of golden.cases) {
      expect(c.id).toBeTruthy();
      expect(c.facts).toBeTruthy();
      expect(Array.isArray(c.facts.strengths)).toBe(true);
      expect(Array.isArray(c.facts.priorities)).toBe(true);
      expect(c.expect).toBeTruthy();
    }
  });

  it('covers the review-mandated grounding cases', () => {
    // null output → fallback
    expect(golden.cases.some((c) => c.model_output === null)).toBe(true);
    // url strip
    expect(
      golden.cases.some((c) => (c.expect.summary_excludes ?? []).some((s) => /http|www/.test(s))),
    ).toBe(true);
    // model-fabricated priority ignored (code titles asserted despite a fake in model_output)
    expect(
      golden.cases.some(
        (c) =>
          c.id.includes('fabricated-priority') ||
          (typeof c.model_output === 'object' &&
            c.model_output !== null &&
            'priorities' in (c.model_output as Record<string, unknown>)),
      ),
    ).toBe(true);
    // model-fabricated strength ignored
    expect(
      golden.cases.some(
        (c) =>
          typeof c.model_output === 'object' &&
          c.model_output !== null &&
          'strengths' in (c.model_output as Record<string, unknown>),
      ),
    ).toBe(true);
    // length cap
    expect(golden.cases.some((c) => c.expect.summary_max_len !== undefined)).toBe(true);
    // templated fallback (blank/non-string summary)
    expect(golden.cases.some((c) => c.expect.summary_nonempty === true)).toBe(true);
    // a VI case
    expect(golden.cases.some((c) => /vi/.test(c.id))).toBe(true);
  });

  it('every golden case PASSES its own expectation (self-consistent)', () => {
    for (const c of golden.cases) {
      const out = scoreInterviewCoachingCase(c);
      if (!out.pass) {
        throw new Error(`golden case ${c.id} failed: ${out.mismatches.join('; ')}`);
      }
      expect(out.pass).toBe(true);
    }
  });
});
