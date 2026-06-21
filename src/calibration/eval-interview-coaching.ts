import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreInterviewCoachingCase,
  InterviewCoachingCase,
} from '../modules/interview/interview-coaching-eval';

/**
 * Interview-coaching GROUNDING eval harness (interview chain Layer 3, PR4). Runs the golden set
 * (data/eval/interview-coaching-golden.json) through `groundCoaching` — the anti-fabrication
 * chokepoint — and checks each case's assertions: code-owned strengths/priorities, summary
 * fallback/url-strip/cap, and that a model-fabricated priority/strength is IGNORED. DETERMINISTIC:
 * exercises the grounding logic only, NOT a live LLM, so it runs with no API key and no network.
 * The live LLM narrative quality is a separate `--live` directional pass later.
 */
function main(): void {
  const file = join(process.cwd(), 'data', 'eval', 'interview-coaching-golden.json');
  const golden = JSON.parse(readFileSync(file, 'utf8')) as { cases: InterviewCoachingCase[] };
  const results = golden.cases.map(scoreInterviewCoachingCase);
  const passed = results.filter((r) => r.pass).length;

  // eslint-disable-next-line no-console
  console.log(`interview-coaching eval: ${passed}/${results.length} pass`);
  const failed = results.filter((r) => !r.pass);
  for (const f of failed) {
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${f.id}: ${f.mismatches.join('; ')}`);
  }
  if (failed.length > 0) process.exit(1);
}

main();
