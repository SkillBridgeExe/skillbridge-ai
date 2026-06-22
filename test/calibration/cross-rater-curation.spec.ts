import { readFileSync } from 'fs';
import { join } from 'path';
import {
  skeletonCurate,
  type CurationEvalCase,
} from '../../src/modules/resource-curation/curation-eval';
import {
  crossRaterAgreement,
  formatCrossRater,
  type RaterLabels,
} from '../../src/calibration/cross-rater-agreement';

/**
 * Slice-3 demonstration: NOMINAL (Cohen's kappa) cross-rater on the curation decision
 * (verified | pending | flagged) — a deterministic-from-metadata verdict, like answer-signals.
 *   system (skeletonCurate → production gate) vs gold (golden expected_status) vs rater2 (a 2nd reading,
 *   stricter on the two adversarial cases — flag rather than hold for review).
 */
type GoldCase = CurationEvalCase;

// rater2 = a stricter independent reading: the two adversarial cases get flagged outright (gold holds them pending).
const RATER2: Record<string, string> = {
  'verify-react-01': 'verified',
  'verify-docker-02': 'verified',
  'verify-borderline-03': 'pending',
  'pending-thin-04': 'pending',
  'pending-low-05': 'pending',
  'pending-softlowq-06': 'pending',
  'flag-promo-07': 'flagged',
  'flag-promo-highq-08': 'flagged',
  'no-skills-09': 'flagged',
  'no-skills-detected-10': 'flagged',
  'url-strip-11': 'verified',
  'soft-outdated-12': 'pending',
  'adversarial-polished-promo-13': 'flagged',
  'adversarial-keyword-stuffed-14': 'flagged',
};

describe('cross-rater on curation decisions (system vs gold vs rater2, nominal kappa)', () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'curation-golden.json'), 'utf8'),
  ) as GoldCase[] | { cases: GoldCase[] };
  const cases: GoldCase[] = Array.isArray(raw) ? raw : raw.cases;

  const system: string[] = [];
  const gold: string[] = [];
  const rater2: string[] = [];
  for (const c of cases) {
    system.push(skeletonCurate(c).validation_status);
    gold.push(c.expected_status);
    rater2.push(RATER2[c.id] ?? c.expected_status);
  }

  const raters: RaterLabels[] = [
    { rater: 'system', labels: system },
    { rater: 'gold', labels: gold },
    { rater: 'rater2', labels: rater2 },
  ];
  const report = crossRaterAgreement(raters, { heuristic: 'system' });

  it('runs over all curation golden cases with three decision-raters', () => {
    expect(report.n).toBe(cases.length);
    expect(cases.length).toBeGreaterThanOrEqual(14);
    expect(report.pairwise).toHaveLength(3);
  });

  it('the curation system matches gold (eval-consistent) and reaches the inter-rater ceiling', () => {
    const sysVsGold = report.pairwise.find(
      (p) => (p.a === 'system' && p.b === 'gold') || (p.a === 'gold' && p.b === 'system'),
    );
    expect(sysVsGold!.kappa).toBeGreaterThanOrEqual(0.7);
    expect(report.interRaterCeiling).not.toBeNull();
    expect(report.reachesCeiling).toBe(true);
  });

  it('prints the curation cross-rater report', () => {
    // eslint-disable-next-line no-console
    console.log('\n' + formatCrossRater(report) + '\n');
    expect(report).toBeDefined();
  });
});
