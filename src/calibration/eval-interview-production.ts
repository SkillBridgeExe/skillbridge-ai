import { readFileSync } from 'fs';
import { join } from 'path';
import {
  InterviewProductionCase,
  scoreInterviewProductionCase,
} from '../modules/interview/interview-production-eval';

/**
 * Interview production eval harness (Wave I-TRUST). Runs the golden corpus
 * (data/eval/interview-production-golden.json) end-to-end through the deterministic interview
 * pieces — L1 signals → grounded insight → decideTurn → gap derive → score aggregation — and
 * gates decisions, flags, gaps, forbidden claims, and score bands. No LLM, no network.
 */

/** guard against accidental corpus truncation — I-OWN grew the corpus to 35 cases. */
const MIN_CASES = 35;

function main(): void {
  const file = join(process.cwd(), 'data', 'eval', 'interview-production-golden.json');
  const golden = JSON.parse(readFileSync(file, 'utf8')) as { cases: InterviewProductionCase[] };
  const results = golden.cases.map(scoreInterviewProductionCase);
  const passed = results.filter((r) => r.pass).length;

  // eslint-disable-next-line no-console
  console.log(`interview-production eval: ${passed}/${results.length} cases pass`);
  for (const r of results.filter((x) => !x.pass)) {
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${r.id} (overall=${r.overall})`);
    for (const m of r.mismatches) {
      // eslint-disable-next-line no-console
      console.log(`    - ${m}`);
    }
  }

  if (results.length < MIN_CASES) {
    // eslint-disable-next-line no-console
    console.log(`corpus shrunk: ${results.length} cases < required ${MIN_CASES}`);
    process.exit(1);
  }
  if (passed !== results.length) process.exit(1);
}

main();
