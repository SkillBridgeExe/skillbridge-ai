export type GapImportance = 'REQUIRED' | 'PREFERRED' | 'NICE_TO_HAVE';

export interface FeasibilityGapInput {
  skill_canonical: string;
  display_name: string;
  severity: number;
  importance: GapImportance;
  required_level: number;
  cv_level: number;
  market_demand: number | null;
  needs_evidence: boolean;
  interview_confirmed: boolean;
  resource_hours?: number | null;
}

export interface FeasibilityBudget {
  available_days: number;
  hours_per_week: number;
}

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

const difficultyMult = (requiredLevel: number): number =>
  1 + (clamp(requiredLevel, 1, 5) - 1) * 0.1;

export function estimatedHours(gap: FeasibilityGapInput): number {
  const levelDelta = Math.max(0, gap.required_level - gap.cv_level);
  if (levelDelta === 0) {
    return 0;
  }

  const formula =
    BASE_HOURS_PER_LEVEL *
    levelDelta *
    difficultyMult(gap.required_level) *
    (gap.needs_evidence ? EVIDENCE_MULT : 1);
  const withFloor = gap.resource_hours != null ? Math.max(formula, gap.resource_hours) : formula;

  return round1(withFloor);
}

const marketFactor = (marketDemand: number | null): number =>
  marketDemand == null ? 1.0 : 1 + (clamp(marketDemand, 0, 100) / 100) * 0.5;

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
  items: FeasibilityItem[];
  feasible_count: number;
  not_feasible: FeasibilityItem[];
}

const SHORT_TIMELINE_DAYS = 7;

export function planFeasibility(
  gaps: FeasibilityGapInput[],
  budget: FeasibilityBudget,
): FeasibilityResult {
  const budget_hours = round1((budget.available_days * budget.hours_per_week) / 7);
  const shortTimeline = budget.available_days <= SHORT_TIMELINE_DAYS;
  const ranked = gaps
    .map((gap) => ({ gap, hours: estimatedHours(gap), priority: priorityOf(gap) }))
    .sort((a, b) => b.priority - a.priority);

  let spent = 0;
  const items = ranked.map(({ gap, hours, priority }) => {
    const fits = spent + hours <= budget_hours;
    if (fits) {
      spent += hours;
    }

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
    feasible_count: items.filter((item) => item.verdict === 'feasible').length,
    not_feasible: items.filter((item) => item.verdict === 'not_feasible_before_deadline'),
  };
}
