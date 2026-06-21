import { readFileSync } from 'fs';
import { join } from 'path';
import { analyzeAnswerSignals } from '../../src/modules/interview/answer-analyzer';
import {
  crossRaterAgreement,
  formatCrossRater,
  type RaterLabels,
} from '../../src/calibration/cross-rater-agreement';

/**
 * Slice-1 demonstration on REAL answers: compare three raters of `has_concrete_example` —
 *   heuristic (L1 analyzeAnswerSignals)  vs  gold (the corpus author, NARROW = needs a number/tech)
 *   vs  rater2 (a second, BROADER reading: any specific real example counts, number or not).
 * gold↔rater2 disagreement IS the documented design tension ("specific" vs "quantified"); the
 * inter-rater ceiling reflects how resolvable the rubric is. The production 3rd rater is the L2
 * answer-insight LLM (shipped #121) run --live — it plugs into the same RaterLabels[] slot.
 */
type RealItem = {
  id: string;
  input: { answer: string; language: 'vi' | 'en'; jd_terms?: string[] };
  gold: { has_concrete_example: boolean };
};

// rater2 = a BROADER independent reading (a specific lived story counts even without a number).
const RATER2: Record<string, boolean> = {
  'real-disagreement-manager': true,
  'real-failed-testing': true,
  'real-led-team-metrics': true,
  'real-pressure-48h': true,
  'real-promotion-goal': false,
  'real-cope-generic': false,
  'real-correct-superior': false,
  'real-member-quit': true,
  'real-missing-requirements': true,
  'real-complex-bug': true,
};

describe('cross-rater on real answer-signals (heuristic vs gold vs rater2)', () => {
  const corpus = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'answer-signals-real.json'), 'utf8'),
  ) as RealItem[];

  const yn = (b: boolean): string => (b ? 'y' : 'n');
  const items = corpus.filter((it) => RATER2[it.id] !== undefined);

  const heuristic: string[] = [];
  const gold: string[] = [];
  const rater2: string[] = [];
  for (const it of items) {
    const sig = analyzeAnswerSignals({
      answer: it.input.answer,
      language: it.input.language,
      jd_terms: it.input.jd_terms ?? [],
    });
    heuristic.push(yn(sig.has_concrete_example));
    gold.push(yn(it.gold.has_concrete_example));
    rater2.push(yn(RATER2[it.id]));
  }

  const raters: RaterLabels[] = [
    { rater: 'heuristic', labels: heuristic },
    { rater: 'gold', labels: gold },
    { rater: 'rater2', labels: rater2 },
  ];
  const report = crossRaterAgreement(raters, { heuristic: 'heuristic' });

  it('runs end-to-end over the real corpus with three raters', () => {
    expect(report.n).toBe(items.length);
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(report.pairwise).toHaveLength(3);
  });

  it('produces a finite inter-rater ceiling and a boolean verdict', () => {
    expect(report.interRaterCeiling).not.toBeNull();
    expect(report.interRaterCeiling as number).toBeGreaterThanOrEqual(-1);
    expect(report.interRaterCeiling as number).toBeLessThanOrEqual(1);
    expect(typeof report.reachesCeiling).toBe('boolean');
  });

  it('prints the cross-rater report for inspection', () => {
    // eslint-disable-next-line no-console
    console.log('\n' + formatCrossRater(report) + '\n');
    expect(report).toBeDefined();
  });
});
