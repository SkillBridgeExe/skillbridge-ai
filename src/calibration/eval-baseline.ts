/**
 * R1 accuracy baseline gate (PURE compare + thin fs helpers). `compareToBaseline` fails when the
 * current eval regresses beyond a margin from the committed baseline (overall within-band,
 * Spearman, or any dimension), OR breaches the absolute floor (backstop, applies even with no
 * baseline). No scoring logic here — measurement/gating only.
 */
import * as fs from 'fs';
import * as path from 'path';

export const BASELINE_DIMS = [
  'action_verbs',
  'skills_relevance',
  'experience',
  'education',
] as const;
export type BaselineDim = (typeof BASELINE_DIMS)[number];

/** Current run, normalized for comparison. within-band + per-dim are 0–100; spearman is 0–1. */
export interface EvalSummary {
  overallWithinBandPct: number;
  spearman: number;
  perDimWithinBandPct: Record<BaselineDim, number>;
}

export interface Baseline {
  generated: string;
  model: string;
  scoring_weights_version: string;
  overall: { within_band_pct: number; spearman: number; mae: number };
  per_dim: Record<BaselineDim, number>;
}

export interface BaselineMargins {
  overall: number;
  spearman: number;
  dim: number;
  absFloorPct: number;
  absSpearmanFloor: number;
}

export interface BaselineComparison {
  pass: boolean;
  failures: string[];
}

export function compareToBaseline(
  current: EvalSummary,
  baseline: Baseline | null,
  m: BaselineMargins,
): BaselineComparison {
  const failures: string[] = [];

  if (current.overallWithinBandPct < m.absFloorPct)
    failures.push(
      `FLOOR overall within-band: ${current.overallWithinBandPct}% < ${m.absFloorPct}%`,
    );
  if (current.spearman < m.absSpearmanFloor)
    failures.push(`FLOOR Spearman: ${current.spearman} < ${m.absSpearmanFloor}`);

  if (baseline) {
    if (current.overallWithinBandPct < baseline.overall.within_band_pct - m.overall)
      failures.push(
        `REGRESS overall within-band: ${current.overallWithinBandPct}% < baseline ${baseline.overall.within_band_pct}% − ${m.overall}`,
      );
    if (current.spearman < baseline.overall.spearman - m.spearman)
      failures.push(
        `REGRESS Spearman: ${current.spearman} < baseline ${baseline.overall.spearman} − ${m.spearman}`,
      );
    for (const d of BASELINE_DIMS) {
      const cur = current.perDimWithinBandPct[d];
      const base = baseline.per_dim[d];
      if (base !== undefined && cur < base - m.dim)
        failures.push(`REGRESS ${d}: ${cur}% < baseline ${base}% − ${m.dim}`);
    }
  }

  return { pass: failures.length === 0, failures };
}

/** PURE: build a Baseline snapshot from the current run + metadata. */
export function toBaseline(
  current: EvalSummary,
  meta: { generated: string; model: string; scoring_weights_version: string; mae: number },
): Baseline {
  return {
    generated: meta.generated,
    model: meta.model,
    scoring_weights_version: meta.scoring_weights_version,
    overall: {
      within_band_pct: current.overallWithinBandPct,
      spearman: current.spearman,
      mae: meta.mae,
    },
    per_dim: { ...current.perDimWithinBandPct },
  };
}

const BASELINE_PATH = path.join(process.cwd(), 'data', 'eval-baseline.json');

export function loadBaseline(): Baseline | null {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
}

export function writeBaseline(b: Baseline): void {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 2) + '\n');
}
