import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreLearningCase,
  LearningAnswer,
  LearningEvalCase,
  LearningEvalResult,
} from '../modules/roadmap/learning-eval';
import type { RetrievedResource } from '../modules/roadmap/resource-embedding';

/**
 * Learning-chatbot eval harness. Two modes:
 *  - SKELETON (default, offline): each case is "answered" with its own expected citations → proves the
 *    golden set + scorer are self-consistent (30/30). No LLM. Exits non-zero on any failure (a CI gate).
 *  - REAL (LEARNING_EVAL_REAL=1 + OPENAI_API_KEY): runs the actual ChatService.turn over each case's
 *    FIXED retrieved set (a stub retriever feeds the golden resources, so this measures generation +
 *    grounding, not retrieval) and scores the real model output. A MEASUREMENT, not a gate (exits 0).
 */

const GOLDEN = join(process.cwd(), 'data', 'eval', 'learning-golden.json');

type AnswerFn = (c: LearningEvalCase) => Promise<LearningAnswer> | LearningAnswer;

const skeletonAnswer: AnswerFn = (c) => ({
  message: c.expected_behavior,
  cited_resource_ids: c.expected_cited_resource_ids,
});

/** Build the REAL ChatService.turn answer fn — deps constructed directly (no AppModule/DB boot). */
async function buildRealAnswerFn(): Promise<AnswerFn> {
  const { ConfigService } = await import('@nestjs/config');
  const { LlmService } = await import('../infrastructure/llm/llm.service');
  const { OpenAiProvider } = await import('../infrastructure/llm/providers/openai.provider');
  const { GeminiProvider } = await import('../infrastructure/llm/providers/gemini.provider');
  const { PromptsService } = await import('../modules/prompts/prompts.service');
  const { TemplateRenderer } = await import('../modules/prompts/template-renderer');
  const { ChatService } = await import('../modules/learning-chat/learning-chat.service');

  const cfg = new ConfigService({
    llm: {
      providerDefault: 'openai',
      openai: {
        apiKey: process.env.OPENAI_API_KEY,
        modelDefault: process.env.OPENAI_MODEL_DEFAULT ?? 'gpt-5.4-mini',
      },
      gemini: { apiKey: '' },
    },
  });
  const llm = new LlmService(cfg, new GeminiProvider(cfg), new OpenAiProvider(cfg));
  const prompts = new PromptsService(new TemplateRenderer());
  await prompts.onModuleInit();

  return async (c: LearningEvalCase): Promise<LearningAnswer> => {
    // Stub retriever returns the case's FIXED golden set → we evaluate generation + grounding, not retrieval.
    const retrieved: RetrievedResource[] = c.retrieved_resources.map((r, i) => ({
      resource_id: r.resource_id,
      rank: i + 1,
      title: r.title,
      provider: '',
      source_type: r.source_type as RetrievedResource['source_type'],
      outcome_type: 'understand',
    }));
    const stubRetriever = { nearest: async () => retrieved } as never;
    const chat = new ChatService(stubRetriever, llm, prompts);
    const out = await chat.turn({ question: c.user_question, language: 'vi' });
    return {
      message: out.message,
      cited_resource_ids: out.cited_resources.map((r) => r.resource_id),
    };
  };
}

function report(results: (LearningEvalResult & { category: string })[]): void {
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
    '(RAGAS note: faithfulness/answer_relevancy are LLM-scored — context_recall + grounding + cited_match run here.)',
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
  }
}

async function main(): Promise<void> {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { cases: LearningEvalCase[] };

  const wantReal = !!process.env.LEARNING_EVAL_REAL && !!process.env.OPENAI_API_KEY;
  let answerFn: AnswerFn = skeletonAnswer;
  if (wantReal) {
    try {
      answerFn = await buildRealAnswerFn();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`real mode unavailable (${(e as Error).message}) — running skeleton`);
    }
  }
  const isReal = answerFn !== skeletonAnswer;
  // eslint-disable-next-line no-console
  console.log(
    `mode: ${isReal ? 'REAL ChatService.turn (live LLM)' : 'skeleton (offline; golden↔scorer self-consistency)'}`,
  );

  const results: (LearningEvalResult & { category: string })[] = [];
  for (const c of golden.cases) {
    results.push({ category: c.category, ...scoreLearningCase(c, await answerFn(c)) });
  }
  report(results);

  // Skeleton is a consistency GATE (must be 30/30); real mode is a MEASUREMENT (never fails the process).
  if (!isReal && results.some((r) => !r.pass)) process.exit(1);
}

void main();
