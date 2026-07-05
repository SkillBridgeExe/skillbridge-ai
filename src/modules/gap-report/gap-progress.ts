import { GapItem } from '../gap-engine/gap-item';
import { JdIntelligenceItem } from './gap-report';

export interface ProgressDelta {
  baseline: boolean;
  prev_count: number;
  curr_count: number;
  gaps_closed: string[];
  gaps_worsened: string[];
  avg_severity_delta: number;
  /** Overall match score of the previous run for the same CV+JD (null at baseline). */
  prev_score: number | null;
  /** Overall match score of the current run (null when unknown). */
  curr_score: number | null;
}

const OPEN_STATUSES = new Set<GapItem['cv_status']>([
  'missing',
  'partial',
  'unproven',
  'overclaimed',
]);

const openGaps = (items: GapItem[]): GapItem[] =>
  items.filter((item) => OPEN_STATUSES.has(item.cv_status));

export const openGapCount = (items: GapItem[]): number => openGaps(items).length;

const avgSeverity = (items: GapItem[]): number =>
  items.length ? items.reduce((sum, item) => sum + item.severity, 0) / items.length : 0;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function diffGapProgress(
  prev: GapItem[],
  curr: GapItem[],
  prevScore: number | null = null,
  currScore: number | null = null,
): ProgressDelta {
  const prevOpen = openGaps(prev);
  const currOpen = openGaps(curr);
  const prevNames = new Set(prevOpen.map((item) => item.canonical_name));
  const currNames = new Set(currOpen.map((item) => item.canonical_name));

  return {
    baseline: false,
    prev_count: prevOpen.length,
    curr_count: currOpen.length,
    gaps_closed: [...prevNames].filter((name) => !currNames.has(name)),
    gaps_worsened: [...currNames].filter((name) => !prevNames.has(name)),
    avg_severity_delta: round3(avgSeverity(currOpen) - avgSeverity(prevOpen)),
    prev_score: prevScore,
    curr_score: currScore,
  };
}

export function baselineProgress(
  curr: GapItem[] | number,
  currScore: number | null = null,
): ProgressDelta {
  return {
    baseline: true,
    prev_count: 0,
    curr_count: Array.isArray(curr) ? openGapCount(curr) : curr,
    gaps_closed: [],
    gaps_worsened: [],
    avg_severity_delta: 0,
    prev_score: null,
    curr_score: currScore,
  };
}

// ── Full progress report (per-gap transitions + JD-dimension + evidence honesty) ────────────────
// Additive on top of ProgressDelta/diffGapProgress/baselineProgress above — those stay unchanged.

export type TransitionKind = 'closed' | 'improved' | 'worsened' | 'new' | 'unchanged';

export interface GapTransition {
  canonical_name: string;
  display_name: string;
  prev_status: GapItem['cv_status'] | null;
  curr_status: GapItem['cv_status'];
  kind: TransitionKind;
  prev_severity: number | null;
  curr_severity: number;
}

export interface DimensionChange {
  dimension: string;
  prev_verdict: string;
  curr_verdict: string;
  changed: boolean;
}

export interface ProgressReport extends ProgressDelta {
  transitions: GapTransition[];
  dimension_changes: DimensionChange[];
  evidence_recognized: string[]; // display_name
  strengths_kept: string[]; // display_name
  required_coverage_delta: number | null;
  template_changed: boolean;
  /** V2 (Wave VALUE_CHAIN): canonicals of STILL-OPEN gaps whose SkillBridge lesson the user has
   *  fully mastered — PENDING VERIFICATION only ("đã học xong X — sẽ kiểm chứng ở lần quét tới").
   *  Presentation data: it never lowers evidence_risk/severity (finishing a course ≠ CV evidence).
   *  Absent (never []) when there is nothing mastered, keeping prior outputs byte-identical. */
  learning_completed?: string[];
}

const STATUS_RANK: Record<GapItem['cv_status'], number> = {
  missing: 0,
  overclaimed: 1,
  unproven: 2,
  partial: 3,
  matched: 4,
};

const EVIDENCE_RECOGNIZED_RISK = new Set<GapItem['evidence_risk']>(['listed_only', 'unproven']);
const EVIDENCE_RECOGNIZED_PREV_STATUS = new Set<GapItem['cv_status']>(['unproven', 'overclaimed']);
const EVIDENCE_RECOGNIZED_CURR_STATUS = new Set<GapItem['cv_status']>(['matched', 'partial']);

const verdictOf = (item: JdIntelligenceItem): string =>
  item.verdict ?? (item.graded ? 'gap' : 'ok');

/** Mastered ∩ still-open gap canonicals (deduped — one canonical may back several requirements).
 *  Closed/matched gaps are deliberately NOT listed: nothing is pending verification for them. */
const learningCompleted = (curr: GapItem[], mastered?: ReadonlySet<string> | null): string[] =>
  mastered?.size
    ? [
        ...new Set(
          openGaps(curr)
            .filter((item) => mastered.has(item.canonical_name))
            .map((item) => item.canonical_name),
        ),
      ]
    : [];

export function buildProgressReport(
  prev: GapItem[],
  curr: GapItem[],
  opts: {
    prevScore: number | null;
    currScore: number | null;
    prevCoverage: number | null;
    currCoverage: number | null;
    prevJdIntel?: JdIntelligenceItem[] | null;
    currJdIntel?: JdIntelligenceItem[] | null;
    templateChanged: boolean;
    /** V2: skills whose learning content the user fully mastered (platform-fetched). Absent/empty ⇒
     *  output byte-identical (same guard style as interviewSignals/corroborated). */
    masteredCanonicals?: ReadonlySet<string> | null;
  },
): ProgressReport {
  const base = diffGapProgress(
    prev,
    curr,
    opts.templateChanged ? null : opts.prevScore,
    opts.currScore,
  );
  const prevBy = new Map(prev.map((item) => [item.canonical_name, item]));

  const transitions: GapTransition[] = [];
  const evidence_recognized: string[] = [];
  const strengths_kept: string[] = [];
  for (const c of curr) {
    const p = prevBy.get(c.canonical_name) ?? null;
    if (p && p.cv_status === 'matched' && c.cv_status === 'matched') {
      strengths_kept.push(c.display_name);
      continue;
    }

    const prevRank = p ? STATUS_RANK[p.cv_status] : null;
    const currRank = STATUS_RANK[c.cv_status];
    let kind: TransitionKind;
    if (p == null) {
      if (c.cv_status === 'matched') continue; // net-new "match" without a prior baseline: nothing to report
      kind = 'new';
    } else if (currRank === 4 && prevRank! < 4) {
      kind = 'closed';
    } else if (currRank > prevRank!) {
      kind = 'improved';
    } else if (currRank < prevRank!) {
      kind = 'worsened';
    } else {
      kind = 'unchanged';
    }

    transitions.push({
      canonical_name: c.canonical_name,
      display_name: c.display_name,
      prev_status: p?.cv_status ?? null,
      curr_status: c.cv_status,
      kind,
      prev_severity: p?.severity ?? null,
      curr_severity: c.severity,
    });

    if (
      p &&
      ((EVIDENCE_RECOGNIZED_RISK.has(p.evidence_risk) && c.evidence_risk === 'none') ||
        (EVIDENCE_RECOGNIZED_PREV_STATUS.has(p.cv_status) &&
          EVIDENCE_RECOGNIZED_CURR_STATUS.has(c.cv_status)))
    ) {
      evidence_recognized.push(c.display_name);
    }
  }

  const dimension_changes: DimensionChange[] = [];
  const prevDims = new Map((opts.prevJdIntel ?? []).map((d) => [d.dimension, d]));
  for (const d of opts.currJdIntel ?? []) {
    const pd = prevDims.get(d.dimension);
    if (!pd) continue;
    const prev_verdict = verdictOf(pd);
    const curr_verdict = verdictOf(d);
    dimension_changes.push({
      dimension: d.dimension,
      prev_verdict,
      curr_verdict,
      changed: prev_verdict !== curr_verdict,
    });
  }

  const required_coverage_delta =
    opts.templateChanged || opts.prevCoverage == null || opts.currCoverage == null
      ? null
      : round3(opts.currCoverage - opts.prevCoverage);

  const learning_completed = learningCompleted(curr, opts.masteredCanonicals);

  return {
    ...base,
    transitions,
    dimension_changes,
    evidence_recognized,
    strengths_kept,
    required_coverage_delta,
    template_changed: opts.templateChanged,
    ...(learning_completed.length ? { learning_completed } : {}),
  };
}

export function baselineReport(
  curr: GapItem[],
  currScore: number | null,
  // V2: baseline carries learning_completed too — the learn-then-rescan window (scan once → learn →
  // chat before re-scanning) is exactly when "sẽ kiểm chứng ở lần quét tới" matters most.
  masteredCanonicals?: ReadonlySet<string> | null,
): ProgressReport {
  const learning_completed = learningCompleted(curr, masteredCanonicals);
  return {
    ...baselineProgress(curr, currScore),
    transitions: [],
    dimension_changes: [],
    evidence_recognized: [],
    strengths_kept: [],
    required_coverage_delta: null,
    template_changed: false,
    ...(learning_completed.length ? { learning_completed } : {}),
  };
}
