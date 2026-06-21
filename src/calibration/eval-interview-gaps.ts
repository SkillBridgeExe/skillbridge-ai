import { readFileSync } from 'fs';
import { join } from 'path';
import { scoreGapDeriveCase, GapDeriveCase } from '../modules/interview/interview-gap-derive-eval';

/**
 * Interview-gap-derive eval harness (PR3). Runs the golden set
 * (data/eval/interview-gap-derive-golden.json) through the pure, deterministic `deriveInterviewGaps`
 * and checks each case's expected (weakness_type, skill_canonical) SET plus severity bands. Keeps the
 * signal→gap mapping regression-safe. No LLM, no network. Mirrors eval-answer-signals.ts.
 */
function main(): void {
  const file = join(process.cwd(), 'data', 'eval', 'interview-gap-derive-golden.json');
  const golden = JSON.parse(readFileSync(file, 'utf8')) as { cases: GapDeriveCase[] };
  const results = golden.cases.map(scoreGapDeriveCase);
  const passed = results.filter((r) => r.pass).length;

  // eslint-disable-next-line no-console
  console.log(`interview-gaps eval: ${passed}/${results.length} pass`);
  const failed = results.filter((r) => !r.pass);
  for (const f of failed) {
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${f.id}: ${f.mismatches.join('; ')}`);
  }
  if (failed.length > 0) process.exit(1);
}

main();
