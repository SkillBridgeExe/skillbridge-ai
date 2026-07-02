/**
 * Progress-report eval — golden cases for buildProgressReport() (gap-progress.ts). Fully OFFLINE
 * (no LLM, no DB): fixture GapItemLite arrays go straight into the real buildProgressReport(); this
 * is the GATE for every change to progress transitions / evidence-recognition / template-mismatch
 * guard.
 *
 *   pnpm eval:progress
 *
 * data/eval-progress-cases.json case shape: { name, prev: GapItemLite[], curr: GapItemLite[],
 *   opts: { prevScore, currScore, prevCoverage, currCoverage, templateChanged },
 *   expect: { closed[], improved[], new[], evidence_recognized[], template_changed?, prev_score_null? } }.
 * GapItemLite = { canonical_name, display_name, cv_status, severity, evidence_risk } — the only
 * fields buildProgressReport reads off a GapItem; cast lite → GapItem below.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GapItem } from '../modules/gap-engine/gap-item';
import { buildProgressReport, TransitionKind } from '../modules/gap-report/gap-progress';

interface GapItemLite {
  canonical_name: string;
  display_name: string;
  cv_status: GapItem['cv_status'];
  severity: number;
  evidence_risk: GapItem['evidence_risk'];
}

interface ProgressCase {
  name: string;
  prev: GapItemLite[];
  curr: GapItemLite[];
  opts: {
    prevScore: number | null;
    currScore: number | null;
    prevCoverage: number | null;
    currCoverage: number | null;
    templateChanged: boolean;
  };
  expect: {
    closed: string[];
    improved: string[];
    new: string[];
    evidence_recognized: string[];
    template_changed?: boolean;
    prev_score_null?: boolean;
  };
}

const toGapItems = (lite: GapItemLite[]): GapItem[] => lite as unknown as GapItem[];

const sorted = (values: string[]): string[] => [...values].sort();

const arraysEqual = (a: string[], b: string[]): boolean => {
  const sa = sorted(a);
  const sb = sorted(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
};

function main(): void {
  const file = path.join(process.cwd(), 'data', 'eval-progress-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: ProgressCase[] };

  console.log(`\nProgress-report eval — ${cases.length} cases (offline, 0 LLM calls)\n`);

  const misses: string[] = [];

  for (const c of cases) {
    const report = buildProgressReport(toGapItems(c.prev), toGapItems(c.curr), c.opts);

    const byKind = (kind: TransitionKind): string[] =>
      report.transitions.filter((t) => t.kind === kind).map((t) => t.canonical_name);

    const checks: Array<[string, string[], string[]]> = [
      ['closed', c.expect.closed, byKind('closed')],
      ['improved', c.expect.improved, byKind('improved')],
      ['new', c.expect.new, byKind('new')],
      ['evidence_recognized', c.expect.evidence_recognized, report.evidence_recognized],
    ];
    for (const [field, want, got] of checks) {
      if (!arraysEqual(want, got)) {
        misses.push(
          `  ${c.name}: ${field} = [${sorted(got).join(', ')}], expected [${sorted(want).join(', ')}]`,
        );
      }
    }

    if (
      c.expect.template_changed !== undefined &&
      report.template_changed !== c.expect.template_changed
    ) {
      misses.push(
        `  ${c.name}: template_changed = ${report.template_changed}, expected ${c.expect.template_changed}`,
      );
    }
    if (c.expect.prev_score_null !== undefined) {
      const isNull = report.prev_score === null;
      if (isNull !== c.expect.prev_score_null) {
        misses.push(
          `  ${c.name}: prev_score = ${String(report.prev_score)}, expected ${c.expect.prev_score_null ? 'null' : 'non-null'}`,
        );
      }
    }

    console.log(
      `${c.name.padEnd(24)} closed=[${byKind('closed')}] improved=[${byKind('improved')}] new=[${byKind('new')}] evidence=[${report.evidence_recognized}] template_changed=${report.template_changed} prev_score=${String(report.prev_score)}`,
    );
  }

  console.log('\n=== Summary ===');
  if (misses.length) {
    console.log('Expectation misses:');
    for (const m of misses) console.log(`❌${m}`);
    console.log('');
    process.exit(1);
  }
  console.log(`PASS ${cases.length}/${cases.length}\n`);
}

main();
