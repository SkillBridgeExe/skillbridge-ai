import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreInterviewCase,
  InterviewEvalCase,
} from '../../../src/modules/interview/interview-eval';

const caseOf = (over: Partial<InterviewEvalCase>): InterviewEvalCase => ({
  id: 'c',
  role: 'frontend_developer',
  seniority: 'mid',
  answers: [{ topic_phase: 'SKILL_PROBE', score: 80, depth_signal: 'deep' }],
  expected_overall_band: 'solid',
  expected_dimension_bands: { technical_depth: 'solid' },
  ...over,
});

describe('scoreInterviewCase', () => {
  it('passes when overall band + every expected dimension band match', () => {
    const out = scoreInterviewCase(caseOf({}));
    expect(out).toMatchObject({
      id: 'c',
      overall_band_match: true,
      dimension_bands_match: true,
      pass: true,
    });
  });

  it('fails when the overall band is off', () => {
    const out = scoreInterviewCase(caseOf({ expected_overall_band: 'outstanding' }));
    expect(out.overall_band_match).toBe(false);
    expect(out.pass).toBe(false);
  });

  it('fails when an expected dimension band is wrong', () => {
    const out = scoreInterviewCase(
      caseOf({ expected_dimension_bands: { technical_depth: 'poor' } }),
    );
    expect(out.dimension_bands_match).toBe(false);
    expect(out.pass).toBe(false);
  });
});

describe('interview golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'interview-golden.json'), 'utf8'),
  ) as { cases: InterviewEvalCase[] };

  it('has >=12 well-formed cases covering every role family + edge cases', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(12);
    const families = new Set(golden.cases.map((c) => `${c.role}|${c.seniority}`));
    expect(families.size).toBeGreaterThanOrEqual(6);
    for (const c of golden.cases) {
      expect(c.id).toBeTruthy();
      expect(Array.isArray(c.answers)).toBe(true);
      expect(c.expected_overall_band).toBeTruthy();
    }
  });

  it('every golden case PASSES its own expectation (self-consistent)', () => {
    for (const c of golden.cases) {
      expect(scoreInterviewCase(c).pass).toBe(true);
    }
  });
});
