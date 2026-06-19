import { readFileSync } from 'fs';
import { join } from 'path';
import { scoreLearningCase, LearningEvalCase } from '../../../src/modules/roadmap/learning-eval';

const caseOf = (over: Partial<LearningEvalCase>): LearningEvalCase => ({
  id: 'c',
  category: 'react',
  user_question: 'q',
  context: {},
  retrieved_resources: [{ resource_id: 'r1', title: 'T', source_type: 'course' }],
  expected_cited_resource_ids: ['r1'],
  expected_behavior: 'cite r1',
  ...over,
});

describe('scoreLearningCase', () => {
  it('passes a grounded answer that cites exactly the expected resource', () => {
    const out = scoreLearningCase(caseOf({}), { message: 'learn r1', cited_resource_ids: ['r1'] });
    expect(out).toMatchObject({
      grounded: true,
      cited_match: true,
      honest_empty: true,
      pass: true,
    });
  });

  it('fails grounding when the answer cites a resource NOT in the retrieved set (fabrication)', () => {
    const out = scoreLearningCase(caseOf({}), { message: 'x', cited_resource_ids: ['GHOST'] });
    expect(out.grounded).toBe(false);
    expect(out.pass).toBe(false);
  });

  it('honest empty-state: no resource expected → citing anything fails, citing nothing passes', () => {
    const empty = caseOf({
      category: 'no_resource',
      retrieved_resources: [],
      expected_cited_resource_ids: [],
    });
    expect(scoreLearningCase(empty, { message: 'none', cited_resource_ids: [] }).pass).toBe(true);
    expect(
      scoreLearningCase(empty, { message: 'x', cited_resource_ids: ['r1'] }).honest_empty,
    ).toBe(false);
  });

  it('fails cited_match when it cites a different (but retrieved) resource', () => {
    const c = caseOf({
      retrieved_resources: [
        { resource_id: 'r1', title: 'a', source_type: 'course' },
        { resource_id: 'r2', title: 'b', source_type: 'course' },
      ],
      expected_cited_resource_ids: ['r1'],
    });
    const out = scoreLearningCase(c, { message: 'x', cited_resource_ids: ['r2'] });
    expect(out.grounded).toBe(true); // r2 IS retrieved
    expect(out.cited_match).toBe(false);
    expect(out.pass).toBe(false);
  });
});

describe('learning golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'learning-golden.json'), 'utf8'),
  ) as { cases: LearningEvalCase[] };

  it('has 20-30 well-formed cases with the grounding invariant (expected ⊆ retrieved)', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(20);
    expect(golden.cases.length).toBeLessThanOrEqual(30);
    for (const c of golden.cases) {
      expect(c.id).toBeTruthy();
      expect(c.user_question).toBeTruthy();
      expect(Array.isArray(c.retrieved_resources)).toBe(true);
      expect(Array.isArray(c.expected_cited_resource_ids)).toBe(true);
      const ids = new Set(c.retrieved_resources.map((r) => r.resource_id));
      for (const e of c.expected_cited_resource_ids) expect(ids.has(e)).toBe(true);
    }
  });

  it('covers every required category', () => {
    const cats = new Set(golden.cases.map((c) => c.category));
    for (const need of [
      'react',
      'docker',
      'english',
      'interview',
      'cv_fix',
      'urgent',
      'no_resource',
      'low_confidence',
    ]) {
      expect(cats.has(need)).toBe(true);
    }
  });

  it('every golden case PASSES when answered with its own expected citations (harness self-consistent)', () => {
    for (const c of golden.cases) {
      const out = scoreLearningCase(c, {
        message: c.expected_behavior,
        cited_resource_ids: c.expected_cited_resource_ids,
      });
      expect(out.pass).toBe(true);
    }
  });
});
