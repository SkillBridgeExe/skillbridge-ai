import { GapItem } from '../gap-engine/gap-item';

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
