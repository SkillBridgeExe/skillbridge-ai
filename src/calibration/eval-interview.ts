import { readFileSync } from 'fs';
import { join } from 'path';
import { scoreInterviewCase, InterviewEvalCase } from '../modules/interview/interview-eval';

/**
 * Interview-scoring eval harness. Runs the golden set (data/eval/interview-golden.json) through the
 * deterministic aggregator and checks overall + dimension banding. Self-consistent today; swap in real
 * graded interviews when a labelled corpus exists. No LLM, no network.
 */
function main(): void {
  const file = join(process.cwd(), 'data', 'eval', 'interview-golden.json');
  const golden = JSON.parse(readFileSync(file, 'utf8')) as { cases: InterviewEvalCase[] };
  const results = golden.cases.map(scoreInterviewCase);
  const passed = results.filter((r) => r.pass).length;

  // eslint-disable-next-line no-console
  console.log(`interview eval: ${passed}/${results.length} band-consistency pass`);
  const failed = results.filter((r) => !r.pass);
  for (const f of failed) {
    // eslint-disable-next-line no-console
    console.log(
      `  FAIL ${f.id}: overall=${f.overall} band_match=${f.overall_band_match} dims_match=${f.dimension_bands_match}`,
    );
  }
  if (failed.length > 0) process.exit(1);
}

main();
