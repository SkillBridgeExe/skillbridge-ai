import { readFileSync } from 'fs';
import { join } from 'path';
import {
  runAnswerSignalsCalibration,
  formatReport,
  type LabeledAnswer,
} from '../../src/calibration/calibrate-answer-signals';

const load = (file: string): LabeledAnswer[] =>
  JSON.parse(readFileSync(join(process.cwd(), 'data', 'eval', file), 'utf8')) as LabeledAnswer[];

describe('answer-signals calibration (single-annotator self-consistency, NOT validity)', () => {
  const sets: Array<{ name: string; corpus: LabeledAnswer[] }> = [
    { name: 'SYNTHETIC (18, author=me)', corpus: load('answer-signals-labeled.json') },
    {
      name: 'REAL web answers (10, author=external prep sites)',
      corpus: load('answer-signals-real.json'),
    },
  ];

  for (const { name, corpus } of sets) {
    describe(name, () => {
      const report = runAnswerSignalsCalibration(corpus);

      it('runs over the whole corpus', () => {
        expect(report.n).toBe(corpus.length);
      });

      it('every metric is in a valid range (no NaN / out-of-bounds)', () => {
        expect(report.concrete.kappa).toBeGreaterThanOrEqual(-1);
        expect(report.concrete.kappa).toBeLessThanOrEqual(1);
        expect(report.concrete.accuracy).toBeGreaterThanOrEqual(0);
        expect(report.concrete.accuracy).toBeLessThanOrEqual(1);
        expect(Number.isFinite(report.filler.mae)).toBe(true);
        expect(report.star.byPart.result.recall).toBeGreaterThanOrEqual(0);
      });

      it('prints the calibration report for inspection', () => {
        // eslint-disable-next-line no-console
        console.log(`\n===== ${name} =====\n` + formatReport(report) + '\n');
        expect(report).toBeDefined();
      });
    });
  }
});
