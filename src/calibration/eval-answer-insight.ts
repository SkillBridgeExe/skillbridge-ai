import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreAnswerInsightCase,
  AnswerInsightCase,
} from '../modules/interview/answer-insight-eval';

/**
 * Answer-insight GROUNDING eval harness (Answer Analyzer Layer 2, PR2). Runs the golden set
 * (data/eval/answer-insight-golden.json) through `groundAnswerInsight` — the anti-fabrication
 * chokepoint — and checks each case's expected SUBSET of the grounded insight (enums valid,
 * relevance clamped, evidence_quality CODE-DERIVED, off_topic safety net). DETERMINISTIC: exercises
 * the grounding logic only, NOT a live LLM, so it runs with no API key and no network. The live
 * LLM-judgment quality is a separate `--live` directional pass later.
 */
function main(): void {
  const file = join(process.cwd(), 'data', 'eval', 'answer-insight-golden.json');
  const golden = JSON.parse(readFileSync(file, 'utf8')) as { cases: AnswerInsightCase[] };
  const results = golden.cases.map(scoreAnswerInsightCase);
  const passed = results.filter((r) => r.pass).length;

  // eslint-disable-next-line no-console
  console.log(`answer-insight eval: ${passed}/${results.length} pass`);
  const failed = results.filter((r) => !r.pass);
  for (const f of failed) {
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${f.id}: mismatched keys -> ${f.mismatches.join(', ')}`);
  }
  if (failed.length > 0) process.exit(1);
}

main();
