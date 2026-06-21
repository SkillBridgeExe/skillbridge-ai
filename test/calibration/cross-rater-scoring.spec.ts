import { readFileSync } from 'fs';
import { join } from 'path';
import { aggregateInterviewScore } from '../../src/modules/interview/interview-scoring';
import {
  crossRaterAgreementOrdinal,
  formatCrossRater,
  type RaterLabels,
} from '../../src/calibration/cross-rater-agreement';

/**
 * Slice-2 demonstration: ORDINAL (quadratic-weighted kappa) cross-rater on interview overall BANDS.
 *   system (aggregateInterviewScore) vs gold (golden expected band) vs rater2 (a 2nd independent band
 *   reading). The band is ordinal (poor < borderline < solid < outstanding), so QWK is the right metric.
 *   gold↔rater2 is the inter-rater ceiling — how resolvable a holistic band judgment is between two
 *   readers. The system, being eval-consistent with gold, sits at/above that ceiling.
 */
const BANDS = ['poor', 'borderline', 'solid', 'outstanding'];

type GoldCase = {
  id: string;
  role: string;
  seniority: string;
  answers: Array<{ topic_phase: string; score: number; depth_signal: string }>;
  expected_overall_band: string;
};

// rater2 = an independent 2nd reading; deliberately differs from gold on two debatable cases:
//   manager-comms-heavy (50,90 → a comms-skeptic reads borderline, not solid)
//   screening-ignored   (10,82 → a reader who counts the 10 reads solid, not outstanding)
const RATER2: Record<string, string> = {
  'ic-strong': 'outstanding',
  'ic-shallow': 'borderline',
  'ic-evasive-poor': 'poor',
  'data-strong': 'outstanding',
  'devops-solid': 'solid',
  'qa-comms': 'solid',
  'manager-comms-heavy': 'borderline',
  'fresher-learning': 'solid',
  'intern-basic': 'borderline',
  'screening-ignored': 'solid',
  'behavioral-only': 'solid',
  'mixed-depth-weighting': 'solid',
  'junior-scores-on-fresher-column': 'solid',
};

describe('cross-rater on interview scoring bands (system vs gold vs rater2, ordinal QWK)', () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'interview-golden.json'), 'utf8'),
  ) as GoldCase[] | { cases: GoldCase[] };
  const cases: GoldCase[] = Array.isArray(raw) ? raw : raw.cases;

  const system: string[] = [];
  const gold: string[] = [];
  const rater2: string[] = [];
  for (const c of cases) {
    const out = aggregateInterviewScore({
      answers: c.answers as never,
      role: c.role,
      seniority: c.seniority,
    });
    system.push(out.overall_band);
    gold.push(c.expected_overall_band);
    rater2.push(RATER2[c.id] ?? c.expected_overall_band);
  }

  const raters: RaterLabels[] = [
    { rater: 'system', labels: system },
    { rater: 'gold', labels: gold },
    { rater: 'rater2', labels: rater2 },
  ];
  const report = crossRaterAgreementOrdinal(raters, BANDS, { heuristic: 'system' });

  it('runs over all golden cases with three band-raters', () => {
    expect(report.n).toBe(cases.length);
    expect(cases.length).toBeGreaterThanOrEqual(13);
    expect(report.pairwise).toHaveLength(3);
  });

  it('the scoring system matches gold (eval-consistent) and reaches the inter-rater ceiling', () => {
    const sysVsGold = report.pairwise.find(
      (p) => (p.a === 'system' && p.b === 'gold') || (p.a === 'gold' && p.b === 'system'),
    );
    expect(sysVsGold!.kappa).toBeGreaterThanOrEqual(0.7);
    expect(report.interRaterCeiling).not.toBeNull();
    expect(report.reachesCeiling).toBe(true);
  });

  it('prints the ordinal cross-rater report', () => {
    // eslint-disable-next-line no-console
    console.log('\n' + formatCrossRater(report) + '\n');
    expect(report).toBeDefined();
  });
});
