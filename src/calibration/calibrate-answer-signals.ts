/**
 * Calibrate `analyzeAnswerSignals` (Layer-1 deterministic signals) against human labels.
 *
 * ⚠️ Vòng-1 = SINGLE-ANNOTATOR self-consistency (reliability), KHÔNG phải validity. Nó đo "heuristic có
 * khớp ĐỊNH NGHĨA người gán không" (bắt gap regex/word-list), KHÔNG chứng minh định nghĩa khớp thực tế.
 * Lớp chủ quan (band/relevance) cần ≥2 annotator độc lập — không ở đây. Xem CALIBRATION-PLAYBOOK + guideline.
 *
 * Pure: (corpus + analyzer) → report. No IO here (the spec/CLI loads the JSON).
 */
import { analyzeAnswerSignals, type AnswerSignalInput } from '../modules/interview/answer-analyzer';
import {
  binaryAgreement,
  cohenKappa,
  confusionMatrix,
  mae,
  rmse,
  bootstrapCI,
} from './calibration-metrics';

export interface LabeledAnswer {
  id: string;
  note?: string;
  input: AnswerSignalInput;
  gold: {
    has_concrete_example: boolean;
    star: { situation: boolean; task: boolean; action: boolean; result: boolean };
    jd_hits: string[];
    filler_count: number;
  };
}

export interface CalibrationReport {
  n: number;
  concrete: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    kappa: number;
    /** rows = gold (yes,no), cols = predicted (yes,no) */
    confusion: number[][];
    accuracyCI: { lo: number; hi: number };
    mismatches: Array<{ id: string; gold: boolean; predicted: boolean; note?: string }>;
  };
  star: { accuracy: number; f1: number; kappa: number; decisions: number };
  jd: { precision: number; recall: number; f1: number; decisions: number };
  filler: { mae: number; rmse: number };
}

const STAR_PARTS = ['situation', 'task', 'action', 'result'] as const;

export function runAnswerSignalsCalibration(corpus: LabeledAnswer[]): CalibrationReport {
  const concPred: boolean[] = [];
  const concGold: boolean[] = [];
  const mismatches: CalibrationReport['concrete']['mismatches'] = [];
  const starPred: boolean[] = [];
  const starGold: boolean[] = [];
  const jdPred: boolean[] = [];
  const jdGold: boolean[] = [];
  const fillerPred: number[] = [];
  const fillerGold: number[] = [];

  for (const item of corpus) {
    const sig = analyzeAnswerSignals(item.input);

    concPred.push(sig.has_concrete_example);
    concGold.push(item.gold.has_concrete_example);
    if (sig.has_concrete_example !== item.gold.has_concrete_example) {
      mismatches.push({
        id: item.id,
        gold: item.gold.has_concrete_example,
        predicted: sig.has_concrete_example,
        note: item.note,
      });
    }

    for (const part of STAR_PARTS) {
      starPred.push(sig.star[part]);
      starGold.push(item.gold.star[part]);
    }

    for (const term of item.input.jd_terms ?? []) {
      jdPred.push(sig.jd_term_hits.hit.includes(term));
      jdGold.push(item.gold.jd_hits.includes(term));
    }

    fillerPred.push(sig.filler.count);
    fillerGold.push(item.gold.filler_count);
  }

  const cb = binaryAgreement(concPred, concGold);
  const correct = concPred.map((p, i) => (p === concGold[i] ? 1 : 0));
  const ci = bootstrapCI(correct, (v) => v.reduce((a, b) => a + b, 0) / v.length);
  const toYN = (b: boolean): string => (b ? 'yes' : 'no');

  const sb = binaryAgreement(starPred, starGold);
  const jb = binaryAgreement(jdPred, jdGold);

  return {
    n: corpus.length,
    concrete: {
      accuracy: cb.accuracy,
      precision: cb.precision,
      recall: cb.recall,
      f1: cb.f1,
      kappa: cohenKappa(concPred.map(toYN), concGold.map(toYN)),
      confusion: confusionMatrix(concPred.map(toYN), concGold.map(toYN), ['yes', 'no']),
      accuracyCI: { lo: ci.lo, hi: ci.hi },
      mismatches,
    },
    star: {
      accuracy: sb.accuracy,
      f1: sb.f1,
      kappa: cohenKappa(starPred.map(toYN), starGold.map(toYN)),
      decisions: starPred.length,
    },
    jd: { precision: jb.precision, recall: jb.recall, f1: jb.f1, decisions: jdPred.length },
    filler: { mae: mae(fillerPred, fillerGold), rmse: rmse(fillerPred, fillerGold) },
  };
}

const pct = (x: number): string => (x * 100).toFixed(0) + '%';
const f2 = (x: number): string => x.toFixed(2);

/** Human-readable report. The mismatch list is the actionable part — each is a heuristic vs human gap. */
export function formatReport(r: CalibrationReport): string {
  const c = r.concrete;
  const lines = [
    `ANSWER-SIGNALS CALIBRATION  (N=${r.n}, single-annotator self-consistency — reliability, not validity)`,
    ``,
    `has_concrete_example  acc=${pct(c.accuracy)}  P=${f2(c.precision)} R=${f2(c.recall)} F1=${f2(c.f1)}  kappa=${f2(c.kappa)}  [ship-gate kappa>=0.70]`,
    `  accuracy 95% bootstrap CI: [${pct(c.accuracyCI.lo)}, ${pct(c.accuracyCI.hi)}]  (wide = small N, treat as smoke)`,
    `  confusion (rows=gold yes/no, cols=pred yes/no): ${JSON.stringify(c.confusion)}`,
    `STAR parts (pooled ${r.star.decisions})  acc=${pct(r.star.accuracy)} F1=${f2(r.star.f1)} kappa=${f2(r.star.kappa)}`,
    `jd_term coverage (pooled ${r.jd.decisions})  P=${f2(r.jd.precision)} R=${f2(r.jd.recall)} F1=${f2(r.jd.f1)}`,
    `filler_count  MAE=${f2(r.filler.mae)} RMSE=${f2(r.filler.rmse)}  (noisiest signal)`,
    ``,
    c.mismatches.length === 0
      ? `concrete mismatches: NONE — heuristic matches annotator on every item.`
      : `concrete mismatches (${c.mismatches.length}) — each = a heuristic/annotator gap to inspect:`,
    ...c.mismatches.map(
      (m) => `  - ${m.id}: gold=${m.gold} pred=${m.predicted}  (${m.note ?? ''})`,
    ),
  ];
  return lines.join('\n');
}
