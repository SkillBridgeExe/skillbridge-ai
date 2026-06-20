import { readFileSync } from 'fs';
import { join } from 'path';
import { scoreLearningCase, LearningEvalCase } from '../../../src/modules/roadmap/learning-eval';

const caseOf = (over: Partial<LearningEvalCase>): LearningEvalCase => ({
  id: 'c',
  category: 'react',
  user_question: 'q',
  context: {},
  retrieved_resources: [{ resource_id: 'r1', title: 'T', source_type: 'course' }],
  gold_resource_ids: ['r1'],
  expected_cited_resource_ids: ['r1'],
  expected_behavior: 'cite r1',
  ...over,
});

describe('scoreLearningCase — answer quality', () => {
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
      gold_resource_ids: [],
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

  it('fails when message embeds a raw URL even with empty citations (anti-fabrication)', () => {
    const c = caseOf({
      category: 'no_resource',
      retrieved_resources: [],
      gold_resource_ids: [],
      expected_cited_resource_ids: [],
    });
    const out = scoreLearningCase(c, {
      message: 'Just use https://fake-course.example',
      cited_resource_ids: [],
    });
    expect(out.no_raw_url).toBe(false);
    expect(out.pass).toBe(false); // citations are empty + grounded, but the message fabricated a link
  });

  it('fails cited_match when the answer repeats a citation (duplicate)', () => {
    const c = caseOf({
      retrieved_resources: [
        { resource_id: 'r1', title: 'a', source_type: 'course' },
        { resource_id: 'r2', title: 'b', source_type: 'course' },
      ],
      gold_resource_ids: ['r1', 'r2'],
      expected_cited_resource_ids: ['r1', 'r2'],
    });
    const out = scoreLearningCase(c, { message: 'm', cited_resource_ids: ['r1', 'r1'] });
    expect(out.grounded).toBe(true); // both 'r1' are retrieved
    expect(out.cited_match).toBe(false); // duplicate + missing r2 must not pass
    expect(out.pass).toBe(false);
  });
});

describe('scoreLearningCase — context_recall (RAGAS retrieval metric)', () => {
  const answer = (ids: string[]) => ({ message: 'm', cited_resource_ids: ids });

  it('is 1 when all gold resources are retrieved', () => {
    expect(
      scoreLearningCase(caseOf({ gold_resource_ids: ['r1'] }), answer(['r1'])).context_recall,
    ).toBe(1);
  });

  it('is 0.5 on partial recall (one of two gold resources retrieved)', () => {
    const c = caseOf({
      retrieved_resources: [{ resource_id: 'r1', title: 'a', source_type: 'course' }],
      gold_resource_ids: ['r1', 'r2'],
      expected_cited_resource_ids: ['r1'],
    });
    expect(scoreLearningCase(c, answer(['r1'])).context_recall).toBe(0.5);
  });

  it('is 0 when the gold resource was NOT retrieved (retrieval miss)', () => {
    const c = caseOf({
      retrieved_resources: [{ resource_id: 'r-wrong', title: 'x', source_type: 'course' }],
      gold_resource_ids: ['r-gold'],
      expected_cited_resource_ids: [],
    });
    const out = scoreLearningCase(c, answer([]));
    expect(out.context_recall).toBe(0);
    expect(out.pass).toBe(true); // honest empty-state is the CORRECT answer when retrieval missed
  });

  it('is 1 (vacuous) when there is no gold resource (no-resource / vague case)', () => {
    expect(scoreLearningCase(caseOf({ gold_resource_ids: [] }), answer([])).context_recall).toBe(1);
  });
});

describe('learning golden set', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'learning-golden.json'), 'utf8'),
  ) as { cases: LearningEvalCase[] };

  it('has >=30 well-formed cases (RAGAS directional minimum) with the invariants', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(30);
    for (const c of golden.cases) {
      expect(c.id).toBeTruthy();
      expect(c.user_question).toBeTruthy();
      expect(Array.isArray(c.retrieved_resources)).toBe(true);
      expect(Array.isArray(c.gold_resource_ids)).toBe(true);
      expect(Array.isArray(c.expected_cited_resource_ids)).toBe(true);
      // grounding invariant: expected cited ⊆ retrieved
      const ids = new Set(c.retrieved_resources.map((r) => r.resource_id));
      for (const e of c.expected_cited_resource_ids) expect(ids.has(e)).toBe(true);
    }
  });

  it('covers every required category + the retrieval-quality categories', () => {
    const cats = new Set(golden.cases.map((c) => c.category));
    for (const need of [
      'react',
      'docker',
      'english',
      'interview',
      'cv_fix',
      'urgent',
      'no_resource',
      'retrieval_miss',
      'vague',
    ]) {
      expect(cats.has(need)).toBe(true);
    }
  });

  it('exercises context_recall < 1 (at least one retrieval-miss case)', () => {
    const recalls = golden.cases.map(
      (c) =>
        scoreLearningCase(c, { message: 'm', cited_resource_ids: c.expected_cited_resource_ids })
          .context_recall,
    );
    expect(recalls.some((r) => r < 1)).toBe(true);
  });

  it('every golden case PASSES (answer quality) when answered with its own expected citations', () => {
    for (const c of golden.cases) {
      const out = scoreLearningCase(c, {
        message: c.expected_behavior,
        cited_resource_ids: c.expected_cited_resource_ids,
      });
      expect(out.pass).toBe(true);
    }
  });
});
