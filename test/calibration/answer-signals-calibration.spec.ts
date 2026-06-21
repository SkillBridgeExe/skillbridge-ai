import { readFileSync } from 'fs';
import { join } from 'path';
import {
  runAnswerSignalsCalibration,
  formatReport,
  type LabeledAnswer,
} from '../../src/calibration/calibrate-answer-signals';

describe('answer-signals calibration (single-annotator self-consistency, NOT validity)', () => {
  const corpus = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'answer-signals-labeled.json'), 'utf8'),
  ) as LabeledAnswer[];
  const report = runAnswerSignalsCalibration(corpus);

  it('runs over the whole labelled corpus', () => {
    expect(report.n).toBe(corpus.length);
    expect(corpus.length).toBeGreaterThanOrEqual(15);
  });

  it('every metric is in a valid range (no NaN / out-of-bounds)', () => {
    expect(report.concrete.kappa).toBeGreaterThanOrEqual(-1);
    expect(report.concrete.kappa).toBeLessThanOrEqual(1);
    expect(report.concrete.accuracy).toBeGreaterThanOrEqual(0);
    expect(report.concrete.accuracy).toBeLessThanOrEqual(1);
    expect(Number.isFinite(report.filler.mae)).toBe(true);
    expect(report.jd.precision).toBeGreaterThanOrEqual(0);
  });

  it('prints the calibration report for inspection', () => {
    // eslint-disable-next-line no-console
    console.log('\n' + formatReport(report) + '\n');
    expect(report).toBeDefined();
  });
});
