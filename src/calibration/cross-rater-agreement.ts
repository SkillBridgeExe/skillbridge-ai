/**
 * Cross-rater agreement — generic multi-rater calibration (Slice 1 of the production eval program).
 *
 * Operationalizes the calibration-playbook rigor: a heuristic must be benchmarked against MULTIPLE
 * raters, and it can never be more trustworthy than the inter-rater "ceiling" (how much the human-ish
 * raters agree with EACH OTHER). Reuses `cohenKappa` (chance-corrected) from calibration-metrics.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║ HONESTY: when the non-heuristic "raters" are LLM judges (not humans), this is ║
 * ║ a CONSISTENCY proxy, not validity — shared-model bias is not mitigated (same  ║
 * ║ caveat as llm-panel.ts). True validity needs independent HUMAN raters.        ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * Pure (no IO). Each rater supplies one label per item; arrays are index-aligned.
 */
import { cohenKappa } from './calibration-metrics';

export interface RaterLabels {
  /** rater id, e.g. 'heuristic', 'gold', 'rater2', 'llm-judge-b'. */
  rater: string;
  /** one categorical label per item, index-aligned across all raters. */
  labels: string[];
}

export interface PairwiseAgreement {
  a: string;
  b: string;
  kappa: number;
}

export interface CrossRaterReport {
  raters: string[];
  n: number;
  /** Cohen's kappa for every rater pair. */
  pairwise: PairwiseAgreement[];
  /** highest kappa among pairs that EXCLUDE the heuristic = the inter-rater ceiling (null if <2 non-heuristic raters). */
  interRaterCeiling: number | null;
  /** the heuristic's kappa with each non-heuristic rater, descending. */
  heuristicVsRaters: PairwiseAgreement[];
  /**
   * does the heuristic reach the ceiling within `tolerance`? i.e. its BEST agreement with a rater is
   * >= ceiling - tolerance. null when there is no ceiling (need >=2 non-heuristic raters).
   * A heuristic that "reaches the ceiling" is as good as the raters are with each other — you cannot
   * fairly ask for more without better (e.g. human) ground truth.
   */
  reachesCeiling: boolean | null;
}

function pairKappa(a: RaterLabels, b: RaterLabels): number {
  return cohenKappa(a.labels, b.labels);
}

export function crossRaterAgreement(
  raters: RaterLabels[],
  opts: { heuristic?: string; tolerance?: number } = {},
): CrossRaterReport {
  const heuristic = opts.heuristic ?? 'heuristic';
  const tolerance = opts.tolerance ?? 0.1;
  const n = raters[0]?.labels.length ?? 0;

  const pairwise: PairwiseAgreement[] = [];
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      pairwise.push({
        a: raters[i].rater,
        b: raters[j].rater,
        kappa: pairKappa(raters[i], raters[j]),
      });
    }
  }

  // inter-rater ceiling: best agreement among pairs NOT involving the heuristic.
  const nonHeuristicPairs = pairwise.filter((p) => p.a !== heuristic && p.b !== heuristic);
  const interRaterCeiling = nonHeuristicPairs.length
    ? Math.max(...nonHeuristicPairs.map((p) => p.kappa))
    : null;

  const heuristicVsRaters = pairwise
    .filter((p) => p.a === heuristic || p.b === heuristic)
    .map((p) => ({ a: heuristic, b: p.a === heuristic ? p.b : p.a, kappa: p.kappa }))
    .sort((x, y) => y.kappa - x.kappa);

  const reachesCeiling =
    interRaterCeiling === null || heuristicVsRaters.length === 0
      ? null
      : heuristicVsRaters[0].kappa >= interRaterCeiling - tolerance;

  return {
    raters: raters.map((r) => r.rater),
    n,
    pairwise,
    interRaterCeiling,
    heuristicVsRaters,
    reachesCeiling,
  };
}

const f2 = (x: number): string => x.toFixed(2);

export function formatCrossRater(r: CrossRaterReport): string {
  return [
    `CROSS-RATER AGREEMENT (N=${r.n}, raters: ${r.raters.join(', ')})`,
    `  pairwise kappa:`,
    ...r.pairwise.map((p) => `    ${p.a} ↔ ${p.b}: ${f2(p.kappa)}`),
    `  inter-rater ceiling (non-heuristic best): ${r.interRaterCeiling === null ? 'n/a (need >=2 raters)' : f2(r.interRaterCeiling)}`,
    `  heuristic best vs a rater: ${r.heuristicVsRaters.length ? f2(r.heuristicVsRaters[0].kappa) : 'n/a'}`,
    `  reaches ceiling (±tol): ${r.reachesCeiling === null ? 'n/a' : r.reachesCeiling ? 'YES — as good as raters agree with each other' : 'NO — below the human-ish agreement ceiling'}`,
  ].join('\n');
}
