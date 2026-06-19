import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreLearningCase,
  LearningAnswer,
  LearningEvalCase,
} from '../modules/roadmap/learning-eval';

/**
 * Learning-chatbot eval harness (skeleton). Runs the golden set (data/eval/learning-golden.json) through
 * the deterministic scorer (grounded / cited_match / honest_empty).
 *
 * SKELETON: until RAG-PR2 ships, each case is "answered" with its own expected citations to prove the
 * harness + golden set are self-consistent. When the real chatbot exists, replace `produceAnswer` with
 * `ChatService.turn(...)` output (and feed each case's user_question + context + retrieved_resources in).
 */
function produceAnswer(c: LearningEvalCase): LearningAnswer {
  // TODO(RAG-PR2): const turn = await chat.turn({ question: c.user_question, ... }); return { message: turn.message, cited_resource_ids: turn.cited_resources.map(r => r.resource_id) };
  return { message: c.expected_behavior, cited_resource_ids: c.expected_cited_resource_ids };
}

function main(): void {
  const file = join(process.cwd(), 'data', 'eval', 'learning-golden.json');
  const golden = JSON.parse(readFileSync(file, 'utf8')) as { cases: LearningEvalCase[] };

  const results = golden.cases.map((c) => ({
    category: c.category,
    ...scoreLearningCase(c, produceAnswer(c)),
  }));
  const passed = results.filter((r) => r.pass).length;

  const byCat = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const e = byCat.get(r.category) ?? { pass: 0, total: 0 };
    e.total += 1;
    if (r.pass) e.pass += 1;
    byCat.set(r.category, e);
  }

  const meanRecall = results.reduce((s, r) => s + r.context_recall, 0) / (results.length || 1);

  // eslint-disable-next-line no-console
  console.log(
    `learning eval: ${passed}/${results.length} answer-quality pass · mean context_recall ${meanRecall.toFixed(2)}`,
  );
  for (const [cat, e] of [...byCat.entries()].sort()) {
    // eslint-disable-next-line no-console
    console.log(`  ${cat.padEnd(16)} ${e.pass}/${e.total}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    '(RAGAS note: faithfulness/answer_relevancy are LLM-scored — wired once RAG-PR2 ships; context_recall + grounding + cited_match run today.)',
  );

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.log('FAILURES:');
    for (const f of failed) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${f.id}: grounded=${f.grounded} cited_match=${f.cited_match} honest_empty=${f.honest_empty} no_raw_url=${f.no_raw_url}`,
      );
    }
    process.exit(1);
  }
}

main();
