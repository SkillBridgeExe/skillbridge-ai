import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreCurationCase,
  skeletonCurate,
  CurationEvalCase,
  CurationEvalResult,
} from '../modules/resource-curation/curation-eval';
import type { CuratedResource } from '../modules/resource-curation/curation-scoring';

/**
 * Resource-curation eval harness. Mirrors eval:learning. Two modes:
 *  - SKELETON (default, offline): each case's expected levels/flags run through the REAL adapter + core →
 *    proves the golden labels are self-consistent with the decision rules. CI gate (exit 1 on failure).
 *  - LIVE (--live + OPENAI_API_KEY): runs the actual CurationService.curate per case → measures real LLM
 *    CRAAP agreement vs the gold labels (a MEASUREMENT — exits 0). Deps built directly (TracingService in
 *    stub mode, no DB), mirroring eval-cv-builder.
 */

const GOLDEN = join(process.cwd(), 'data', 'eval', 'curation-golden.json');
type ProduceFn = (c: CurationEvalCase) => Promise<CuratedResource> | CuratedResource;

async function buildLiveProduceFn(): Promise<ProduceFn> {
  const { ConfigService } = await import('@nestjs/config');
  const { LlmService } = await import('../infrastructure/llm/llm.service');
  const { OpenAiProvider } = await import('../infrastructure/llm/providers/openai.provider');
  const { GeminiProvider } = await import('../infrastructure/llm/providers/gemini.provider');
  const { PromptsService } = await import('../modules/prompts/prompts.service');
  const { TemplateRenderer } = await import('../modules/prompts/template-renderer');
  const { TracingService } = await import('../modules/tracing/tracing.service');
  const { CurationService } = await import('../modules/resource-curation/curation.service');

  const cfg = new ConfigService({
    llm: {
      providerDefault: 'openai',
      openai: {
        apiKey: process.env.OPENAI_API_KEY,
        modelDefault: process.env.CURATION_MODEL ?? 'gpt-4o-mini',
      },
      gemini: { apiKey: '' },
    },
  });
  const llm = new LlmService(cfg, new GeminiProvider(cfg), new OpenAiProvider(cfg));
  const prompts = new PromptsService(new TemplateRenderer());
  await prompts.onModuleInit();
  const tracing = new TracingService(); // stub mode (no repos) — no DB needed for eval
  const svc = new CurationService(llm, prompts, tracing);
  return (c) => svc.curate(c.input);
}

function report(
  results: (CurationEvalResult & { category: string; expected: string; actual: string })[],
): void {
  const passed = results.filter((r) => r.pass).length;
  const inBand = results.filter((r) => r.quality_in_band).length;

  const byCat = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const e = byCat.get(r.category) ?? { pass: 0, total: 0 };
    e.total += 1;
    if (r.pass) e.pass += 1;
    byCat.set(r.category, e);
  }

  // eslint-disable-next-line no-console
  console.log(
    `curation eval: ${passed}/${results.length} pass · quality-in-band ${inBand}/${results.length}`,
  );
  for (const [cat, e] of [...byCat.entries()].sort()) {
    // eslint-disable-next-line no-console
    console.log(`  ${cat.padEnd(18)} ${e.pass}/${e.total}`);
  }

  // decision confusion (expected → actual)
  const confusion = new Map<string, number>();
  for (const r of results) {
    const key = `${r.expected}→${r.actual}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }
  // eslint-disable-next-line no-console
  console.log(
    'decision (expected→actual): ' +
      [...confusion.entries()].map(([k, n]) => `${k}:${n}`).join('  '),
  );

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.log('FAILURES:');
    for (const f of failed) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${f.id}: decision=${f.decision_match} no_raw_url=${f.no_raw_url} flags_subset=${f.flags_subset} in_band=${f.quality_in_band} (${f.expected}→${f.actual})`,
      );
    }
  }
}

async function main(): Promise<void> {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { cases: CurationEvalCase[] };

  const wantLive = process.argv.includes('--live') && !!process.env.OPENAI_API_KEY;
  let produce: ProduceFn = skeletonCurate;
  let isLive = false;
  if (wantLive) {
    try {
      produce = await buildLiveProduceFn();
      isLive = true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`live mode unavailable (${(e as Error).message}) — running skeleton`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `mode: ${isLive ? 'LIVE CurationService.curate' : 'skeleton (offline; golden↔core self-consistency)'}`,
  );

  const results: (CurationEvalResult & { category: string; expected: string; actual: string })[] =
    [];
  for (const c of golden.cases) {
    const out = await produce(c);
    results.push({
      category: c.category,
      expected: c.expected_status,
      actual: out.validation_status,
      ...scoreCurationCase(c, out),
    });
  }
  report(results);

  if (!isLive && results.some((r) => !r.pass)) process.exit(1);
}

void main();
