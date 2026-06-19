export type GapImportance = 'REQUIRED' | 'PREFERRED' | 'NICE_TO_HAVE';

/** One learnable gap fed to the planner (mapped from a GapItem by the caller). */
export interface FeasibilityGapInput {
  skill_canonical: string;
  display_name: string;
  severity: number; // 0..1
  importance: GapImportance;
  required_level: number; // 1..5
  cv_level: number; // 0..5
  market_demand: number | null; // 0..100 pct_of_postings, or null
  needs_evidence: boolean; // gap requires demonstrable proof (evidence_gap / add_evidence)
  interview_confirmed: boolean; // also surfaced in the interview (source='both')
  resource_hours?: number | null; // optional: summed duration of the cheapest learning path (cross-check)
}

export interface FeasibilityBudget {
  available_days: number;
  hours_per_week: number;
}

// Documented defaults — calibrate in LR-PR3.
const BASE_HOURS_PER_LEVEL = 8;
const EVIDENCE_MULT = 1.5;
const INTERVIEW_BOOST = 1.3;
const IMPORTANCE_WEIGHT: Record<GapImportance, number> = {
  REQUIRED: 1.0,
  PREFERRED: 0.6,
  NICE_TO_HAVE: 0.3,
};

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Harder targets cost a bit more per level: L1→1.0, L5→1.4. */
const difficultyMult = (requiredLevel: number): number =>
  1 + (clamp(requiredLevel, 1, 5) - 1) * 0.1;

/** Deterministic learn-time. NO importance term (importance affects priority, not time). */
export function estimatedHours(gap: FeasibilityGapInput): number {
  const levelDelta = Math.max(0, gap.required_level - gap.cv_level);
  // H1 (review): a skill already at/above the required level needs NO learning time — return early so
  // the resource floor below can't charge a full course's hours for a non-gap that happens to have a resource.
  if (levelDelta === 0) return 0;
  const formula =
    BASE_HOURS_PER_LEVEL *
    levelDelta *
    difficultyMult(gap.required_level) *
    (gap.needs_evidence ? EVIDENCE_MULT : 1);
  // The cheapest real learning path is a floor — you can't finish faster than the resources take.
  const withFloor = gap.resource_hours != null ? Math.max(formula, gap.resource_hours) : formula;
  return round1(withFloor);
}

const marketFactor = (marketDemand: number | null): number =>
  marketDemand == null ? 1.0 : 1 + (clamp(marketDemand, 0, 100) / 100) * 0.5;

/** Deterministic ranking. Importance lives HERE (not in time). */
export function priorityOf(gap: FeasibilityGapInput): number {
  return round3(
    gap.severity *
      IMPORTANCE_WEIGHT[gap.importance] *
      marketFactor(gap.market_demand) *
      (gap.interview_confirmed ? INTERVIEW_BOOST : 1),
  );
}

export type FeasibilityVerdict = 'feasible' | 'not_feasible_before_deadline';
export type FeasibilityStrategy = 'deep_build' | 'crash_prep';

export interface FeasibilityItem {
  skill_canonical: string;
  display_name: string;
  estimated_hours: number;
  priority: number;
  verdict: FeasibilityVerdict;
  strategy: FeasibilityStrategy;
}

export interface FeasibilityResult {
  budget_hours: number;
  items: FeasibilityItem[]; // sorted by priority desc
  feasible_count: number;
  not_feasible: FeasibilityItem[];
}

const SHORT_TIMELINE_DAYS = 7;

/**
 * Greedy deterministic allocation: rank gaps by priority, fill the hour budget; gaps that don't fit
 * are honestly marked not_feasible_before_deadline. Short timelines (<=7d) force crash_prep even when
 * a gap fits; not-feasible gaps are always crash_prep (don't pretend to teach them deeply in time).
 */
export function planFeasibility(
  gaps: FeasibilityGapInput[],
  budget: FeasibilityBudget,
): FeasibilityResult {
  const budget_hours = round1((budget.available_days * budget.hours_per_week) / 7);
  const shortTimeline = budget.available_days <= SHORT_TIMELINE_DAYS;

  const ranked = gaps
    .map((g) => ({ gap: g, hours: estimatedHours(g), priority: priorityOf(g) }))
    .sort((a, b) => b.priority - a.priority);

  let spent = 0;
  const items: FeasibilityItem[] = ranked.map(({ gap, hours, priority }) => {
    const fits = spent + hours <= budget_hours;
    if (fits) spent += hours;
    const verdict: FeasibilityVerdict = fits ? 'feasible' : 'not_feasible_before_deadline';
    const strategy: FeasibilityStrategy =
      verdict === 'feasible' && !shortTimeline ? 'deep_build' : 'crash_prep';
    return {
      skill_canonical: gap.skill_canonical,
      display_name: gap.display_name,
      estimated_hours: hours,
      priority,
      verdict,
      strategy,
    };
  });

  return {
    budget_hours,
    items,
    feasible_count: items.filter((i) => i.verdict === 'feasible').length,
    not_feasible: items.filter((i) => i.verdict === 'not_feasible_before_deadline'),
  };
}
