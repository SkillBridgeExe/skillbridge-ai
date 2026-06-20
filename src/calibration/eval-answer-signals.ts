import { readFileSync } from 'fs';
import { join } from 'path';
import { scoreAnswerSignalCase, AnswerSignalCase } from '../modules/interview/answer-signals-eval';

/**
 * Answer-signals eval harness (Answer Analyzer Layer 1, PR1). Runs the golden set
 * (data/eval/answer-signals-golden.json) through the deterministic analyzer and checks each case's
 * expected SUBSET of signals. Self-consistent gate — keeps the filler/STAR/concrete heuristics
 * regression-safe. No LLM, no network.
 */
function main(): void {
  const file = join(process.cwd(), 'data', 'eval', 'answer-signals-golden.json');
  const golden = JSON.parse(readFileSync(file, 'utf8')) as { cases: AnswerSignalCase[] };
  const results = golden.cases.map(scoreAnswerSignalCase);
  const passed = results.filter((r) => r.pass).length;

  // eslint-disable-next-line no-console
  console.log(`answer-signals eval: ${passed}/${results.length} pass`);
  const failed = results.filter((r) => !r.pass);
  for (const f of failed) {
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${f.id}: mismatched keys -> ${f.mismatches.join(', ')}`);
  }
  if (failed.length > 0) process.exit(1);
}

main();
