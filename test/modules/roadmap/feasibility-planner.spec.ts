import {
  FeasibilityGapInput,
  estimatedHours,
  planFeasibility,
  priorityOf,
} from '../../../src/modules/roadmap/feasibility-planner';

const gap = (over: Partial<FeasibilityGapInput>): FeasibilityGapInput => ({
  skill_canonical: 'react',
  display_name: 'React',
  severity: 0.8,
  importance: 'REQUIRED',
  required_level: 4,
  cv_level: 2,
  market_demand: null,
  needs_evidence: false,
  interview_confirmed: false,
  resource_hours: null,
  ...over,
});

describe('estimatedHours', () => {
  it('= base(8) * level_delta * difficulty_mult, NO importance term', () => {
    expect(estimatedHours(gap({ required_level: 4, cv_level: 2 }))).toBeCloseTo(20.8);
    expect(estimatedHours(gap({ importance: 'NICE_TO_HAVE' }))).toBeCloseTo(20.8);
  });

  it('applies the evidence multiplier (1.5) when the gap needs demonstrable proof', () => {
    expect(estimatedHours(gap({ needs_evidence: true }))).toBeCloseTo(20.8 * 1.5);
  });

  it('returns 0 hours when there is no level gap', () => {
    expect(estimatedHours(gap({ required_level: 3, cv_level: 5 }))).toBe(0);
  });

  it('uses the resource path as a floor when resource_hours is higher', () => {
    expect(estimatedHours(gap({ resource_hours: 30 }))).toBe(30);
  });
});

describe('priorityOf', () => {
  it('= severity * importance_weight * market_factor * interview_boost', () => {
    expect(priorityOf(gap({}))).toBeCloseTo(0.8);
    expect(priorityOf(gap({ importance: 'PREFERRED' }))).toBeCloseTo(0.48);
    expect(priorityOf(gap({ market_demand: 100 }))).toBeCloseTo(1.2);
    expect(priorityOf(gap({ interview_confirmed: true }))).toBeCloseTo(1.04);
  });
});

describe('planFeasibility', () => {
  it('computes budget_hours = available_days * hours_per_week / 7', () => {
    const out = planFeasibility([], { available_days: 14, hours_per_week: 7 });
    expect(out.budget_hours).toBe(14);
  });

  it('greedily fills by priority and marks overflow as not_feasible_before_deadline', () => {
    const out = planFeasibility(
      [
        gap({ skill_canonical: 'a', display_name: 'A', severity: 0.9 }),
        gap({ skill_canonical: 'b', display_name: 'B', severity: 0.5 }),
      ],
      { available_days: 30, hours_per_week: 7 },
    );

    expect(out.items.map((item) => item.skill_canonical)).toEqual(['a', 'b']);
    expect(out.items[0].verdict).toBe('feasible');
    expect(out.items[1].verdict).toBe('not_feasible_before_deadline');
    expect(out.feasible_count).toBe(1);
    expect(out.not_feasible.map((item) => item.skill_canonical)).toEqual(['b']);
  });

  it('strategy = deep_build when feasible and timeline is long (>7 days)', () => {
    const out = planFeasibility([gap({ required_level: 3, cv_level: 2 })], {
      available_days: 30,
      hours_per_week: 10,
    });

    expect(out.items[0].verdict).toBe('feasible');
    expect(out.items[0].strategy).toBe('deep_build');
  });

  it('strategy = crash_prep on a short timeline (<=7 days) even when feasible', () => {
    const out = planFeasibility([gap({ required_level: 3, cv_level: 2 })], {
      available_days: 2,
      hours_per_week: 40,
    });

    expect(out.items[0].strategy).toBe('crash_prep');
  });

  it('not_feasible items are always crash_prep', () => {
    const out = planFeasibility([gap({ required_level: 5, cv_level: 0, severity: 0.9 })], {
      available_days: 2,
      hours_per_week: 7,
    });

    expect(out.items[0].verdict).toBe('not_feasible_before_deadline');
    expect(out.items[0].strategy).toBe('crash_prep');
  });
});
