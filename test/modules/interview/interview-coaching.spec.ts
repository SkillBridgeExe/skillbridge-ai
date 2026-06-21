import {
  buildCoachingFacts,
  groundCoaching,
  CoachingFacts,
} from '../../../src/modules/interview/interview-coaching';
import { InterviewScore } from '../../../src/modules/interview/interview-scoring';
import { InterviewGapItem } from '../../../src/modules/interview/interview-gap';
import {
  UnifiedDevelopmentPlan,
  UnifiedDevelopmentPlanItem,
} from '../../../src/modules/gap-report/unified-plan';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const score = (over: Partial<InterviewScore> = {}): InterviewScore => ({
  overall: 72,
  overall_band: 'solid',
  role_family: 'ic_eng',
  scored_answers: 5,
  dimensions: [
    { dimension: 'technical_depth', score: 85, band: 'outstanding', weight: 40 },
    { dimension: 'problem_solving', score: 74, band: 'solid', weight: 25 },
    { dimension: 'communication', score: 55, band: 'borderline', weight: 12 },
    { dimension: 'evidence_credibility', score: 35, band: 'poor', weight: 15 },
    { dimension: 'role_fit', score: 81, band: 'outstanding', weight: 8 },
  ],
  ...over,
});

const planItem = (
  over: Partial<UnifiedDevelopmentPlanItem> & Pick<UnifiedDevelopmentPlanItem, 'track'>,
): UnifiedDevelopmentPlanItem => ({
  source: 'interview',
  skill_canonical: null,
  display_name: 'Item',
  priority: 0.5,
  severity: 0.5,
  rationale: 'do the thing',
  ...over,
});

const plan = (over: Partial<UnifiedDevelopmentPlan> = {}): UnifiedDevelopmentPlan => ({
  match_id: 'm1',
  session_id: 's1',
  learn_items: [
    planItem({ track: 'learn', display_name: 'Kubernetes', priority: 0.9, severity: 0.9 }),
    planItem({ track: 'learn', display_name: 'GraphQL', priority: 0.4, severity: 0.4 }),
  ],
  cv_fix_items: [
    planItem({
      track: 'cv_fix',
      display_name: 'React',
      priority: 0.8,
      severity: 0.8,
      weakness_type: 'evidence_gap',
    }),
  ],
  interview_practice_items: [
    planItem({
      track: 'interview_practice',
      display_name: 'STAR storytelling',
      priority: 0.6,
      severity: 0.6,
      weakness_type: 'behavioral_gap',
    }),
  ],
  ...over,
});

const gap = (over: Partial<InterviewGapItem> = {}): InterviewGapItem => ({
  requirement_id: null,
  target_type: 'evidence',
  skill_canonical: 'react',
  display_name: 'React',
  weakness_type: 'evidence_gap',
  severity: 0.8,
  evidence_from_answer: 'no concrete example given',
  recommended_action: 'Add a concrete React example.',
  linked_question_id: 'q1',
  ...over,
});

// ---------------------------------------------------------------------------
// Task 1 — buildCoachingFacts
// ---------------------------------------------------------------------------

describe('buildCoachingFacts', () => {
  it('keeps only solid/outstanding dimensions as strengths, top 3 by score', () => {
    const facts = buildCoachingFacts({ score: score(), gaps: [gap()], plan: plan() });
    // dims solid+: technical_depth(85,outstanding), problem_solving(74,solid), role_fit(81,outstanding)
    // communication(55,borderline) + evidence_credibility(35,poor) excluded.
    expect(facts.strengths.map((s) => s.name)).toEqual([
      'technical_depth',
      'role_fit',
      'problem_solving',
    ]);
    expect(facts.strengths.every((s) => s.band === 'solid' || s.band === 'outstanding')).toBe(true);
  });

  it('pulls priorities across all 3 plan buckets sorted by priority desc, capped', () => {
    const facts = buildCoachingFacts({ score: score(), gaps: [gap()], plan: plan() });
    expect(facts.priorities.length).toBeLessThanOrEqual(4);
    // highest priority first: Kubernetes(0.9) > React(0.8) > STAR(0.6) > GraphQL(0.4)
    expect(facts.priorities[0]).toMatchObject({ track: 'learn', title: 'Kubernetes' });
    expect(facts.priorities.map((p) => p.title)).toContain('React');
    const sorted = [...facts.priorities].sort((a, b) => b.severity - a.severity);
    expect(facts.priorities).toEqual(sorted);
  });

  it('copies overall + band from the score', () => {
    const facts = buildCoachingFacts({ score: score(), gaps: [gap()], plan: plan() });
    expect(facts.overall).toBe(72);
    expect(facts.overall_band).toBe('solid');
  });

  it('surfaces top gaps with display_name + weakness_type sorted by severity', () => {
    const gaps = [
      gap({ display_name: 'React', severity: 0.4, weakness_type: 'evidence_gap' }),
      gap({ display_name: 'Kubernetes', severity: 0.9, weakness_type: 'knowledge_gap' }),
    ];
    const facts = buildCoachingFacts({ score: score(), gaps, plan: plan() });
    expect(facts.top_gaps[0]).toMatchObject({
      display_name: 'Kubernetes',
      weakness_type: 'knowledge_gap',
    });
  });

  it('handles empty inputs without throwing → empty facts', () => {
    const empty: InterviewScore = {
      overall: 0,
      overall_band: 'poor',
      dimensions: [],
      role_family: 'ic_eng',
      scored_answers: 0,
    };
    const emptyPlan: UnifiedDevelopmentPlan = {
      match_id: 'm1',
      session_id: null,
      learn_items: [],
      cv_fix_items: [],
      interview_practice_items: [],
    };
    const facts = buildCoachingFacts({ score: empty, gaps: [], plan: emptyPlan });
    expect(facts.strengths).toEqual([]);
    expect(facts.priorities).toEqual([]);
    expect(facts.top_gaps).toEqual([]);
    expect(facts.overall).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — groundCoaching (anti-fabrication)
// ---------------------------------------------------------------------------

describe('groundCoaching', () => {
  const facts = (): CoachingFacts =>
    buildCoachingFacts({ score: score(), gaps: [gap()], plan: plan() });

  it('passes a valid summary through (trimmed) and code-owns strengths/priorities', () => {
    const parsed = {
      summary: '  Your React depth was solid; add one concrete project example.  ',
      priority_notes: ['JD wants production React evidence.'],
    };
    const out = groundCoaching(parsed, facts());
    expect(out.summary).toBe('Your React depth was solid; add one concrete project example.');
    // strengths are CODE-derived from facts (name: band), NOT from the model.
    expect(out.strengths).toEqual([
      'technical_depth: outstanding',
      'role_fit: outstanding',
      'problem_solving: solid',
    ]);
    // priorities are CODE-owned (track + title from facts); why may come from the model.
    expect(out.priorities.map((p) => p.title)).toEqual(facts().priorities.map((p) => p.title));
    expect(out.priorities[0].why).toBe('JD wants production React evidence.');
  });

  it('strips raw URLs from the summary', () => {
    const parsed = {
      summary: 'Great work — see https://leak.example.com/secret and www.foo.com for more.',
      priority_notes: [],
    };
    const out = groundCoaching(parsed, facts());
    expect(out.summary).not.toContain('http');
    expect(out.summary).not.toContain('leak.example.com');
    expect(out.summary).toContain('[link]');
  });

  it('caps an over-long summary at 600 chars', () => {
    const parsed = { summary: 'x'.repeat(900), priority_notes: [] };
    const out = groundCoaching(parsed, facts());
    expect(out.summary.length).toBeLessThanOrEqual(600);
  });

  it('IGNORES model-fabricated strengths — strengths always match facts count', () => {
    const f = facts();
    const parsed = {
      summary: 'ok',
      strengths: ['Fabricated mastery of Rust', 'Invented Kafka expertise'],
      priority_notes: [],
    } as unknown;
    const out = groundCoaching(parsed, f);
    expect(out.strengths.length).toBe(f.strengths.length);
    expect(out.strengths.join(' ')).not.toContain('Rust');
    expect(out.strengths.join(' ')).not.toContain('Kafka');
  });

  it('IGNORES model attempts to add/remove a priority — count + titles match facts exactly', () => {
    const f = facts();
    const parsed = {
      summary: 'ok',
      priorities: [{ track: 'learn', title: 'FAKE invented priority', why: 'made up' }],
      priority_notes: [],
    } as unknown;
    const out = groundCoaching(parsed, f);
    expect(out.priorities.length).toBe(f.priorities.length);
    expect(out.priorities.map((p) => p.title)).toEqual(f.priorities.map((p) => p.title));
    expect(out.priorities.map((p) => p.title)).not.toContain('FAKE invented priority');
  });

  it('falls back to a templated summary when summary is missing/blank', () => {
    const out = groundCoaching({ summary: '   ', priority_notes: [] }, facts());
    expect(out.summary.length).toBeGreaterThan(0);
    expect(out.summary.toLowerCase()).toContain('solid'); // overall_band woven into the template
  });

  it('parsed === null → full templated fallback (non-empty summary + code strengths/priorities)', () => {
    const f = facts();
    const out = groundCoaching(null, f);
    expect(out.summary.length).toBeGreaterThan(0);
    expect(out.strengths).toEqual([
      'technical_depth: outstanding',
      'role_fit: outstanding',
      'problem_solving: solid',
    ]);
    expect(out.priorities.length).toBe(f.priorities.length);
    // every priority still has a non-empty templated why.
    expect(out.priorities.every((p) => p.why.trim().length > 0)).toBe(true);
  });

  it('uses a templated why when the model omits/blanks a priority_note', () => {
    const f = facts();
    const out = groundCoaching({ summary: 'ok', priority_notes: ['', '   '] }, f);
    expect(out.priorities.every((p) => p.why.trim().length > 0)).toBe(true);
  });

  it('strips URLs + caps the per-priority why from the model', () => {
    const f = facts();
    const out = groundCoaching(
      { summary: 'ok', priority_notes: ['Read https://x.com/y now. ' + 'z'.repeat(400)] },
      f,
    );
    expect(out.priorities[0].why).not.toContain('http');
    expect(out.priorities[0].why.length).toBeLessThanOrEqual(300);
  });

  it('does not throw when facts have no strengths/priorities', () => {
    const emptyFacts: CoachingFacts = {
      overall: 0,
      overall_band: 'poor',
      strengths: [],
      priorities: [],
      top_gaps: [],
    };
    const out = groundCoaching(null, emptyFacts);
    expect(out.strengths).toEqual([]);
    expect(out.priorities).toEqual([]);
    expect(out.summary.length).toBeGreaterThan(0);
  });
});
