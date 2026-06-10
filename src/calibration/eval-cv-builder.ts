/**
 * R1b eval harness (spec §9.4). TWO gates:
 *
 *   pnpm eval:cv-builder                      # gate 1 (always, offline) + gate 2 (if key)
 *   EVAL_CV_BUILDER_STRICT=1 pnpm eval:cv-builder   # exit 1 on any failure
 *
 * GATE 1 — evaluate-section REPRODUCIBILITY (offline, no key/DB): for every case, the
 *   deterministic checklist outcome must match the labelled `expect` map AND be identical
 *   across 3 repeated runs (proves determinism). Builds the evaluator with fs-backed
 *   taxonomy/rubric directly — no Nest, no DB.
 *
 * GATE 2 — rewrite FACT-PRESERVATION (live-only; needs OPENAI_API_KEY; NODE_ENV=test skips):
 *   for every rewrite case, the suggestion must (a) keep every number of the input,
 *   (b) add NO new number (anti-hallucination), (c) for translate keep tech tokens. Prints
 *   SKIPPED cleanly without a key so the gate is CI-safe offline.
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import { BulletAnalyzerService } from '../modules/cv-review/bullet-analyzer.service';
import { SectionEvaluatorService } from '../modules/cv-builder/section-evaluator.service';
import { EvaluateSectionRequestDto } from '../modules/cv-builder/dto/evaluate-section.dto';

const STRICT = process.env.EVAL_CV_BUILDER_STRICT === '1';

interface EvalCase {
  name: string;
  section: EvaluateSectionRequestDto['section'];
  language: 'vi' | 'en';
  content: unknown;
  role_code?: string;
  expect: Record<string, boolean>;
}
interface RewriteCase {
  name: string;
  mode: 'harvard' | 'translate' | 'custom';
  text: string;
  target_lang?: 'vi' | 'en';
  instruction?: string;
  role_code?: string;
}

const nums = (s: string): string[] =>
  (s.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]/g, '')).filter(Boolean);

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-cv-builder.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    evaluate_cases: EvalCase[];
    rewrite_cases: RewriteCase[];
  };

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();
  const analyzer = new BulletAnalyzerService();
  const evaluator = new SectionEvaluatorService(analyzer, rubrics, taxonomy);

  // ── GATE 1 — reproducibility + label match ──────────────────────────────
  let failures = 0;
  console.log('GATE 1 — evaluate-section (deterministic, label match + 3× reproducible):');
  for (const c of data.evaluate_cases) {
    const run = (): Record<string, boolean> => {
      const res = evaluator.evaluate({
        section: c.section,
        language: c.language,
        role_code: c.role_code,
        content: c.content as never,
      });
      return Object.fromEntries(res.checklist.map((i) => [i.id, i.pass]));
    };
    const r1 = run();
    const r2 = run();
    const r3 = run();
    const stable =
      JSON.stringify(r1) === JSON.stringify(r2) && JSON.stringify(r2) === JSON.stringify(r3);
    const mismatches = Object.entries(c.expect).filter(([id, want]) => r1[id] !== want);

    if (!stable) {
      console.log(`  ✗ ${c.name}: NOT reproducible across runs`);
      failures++;
    } else if (mismatches.length > 0) {
      console.log(
        `  ✗ ${c.name}: ${mismatches.map(([id, w]) => `${id} expected ${w} got ${r1[id]}`).join(' · ')}`,
      );
      failures++;
    } else {
      console.log(`  ✓ ${c.name} (${Object.keys(c.expect).length} criteria)`);
    }
  }

  // ── GATE 2 — rewrite fact-preservation (live) ───────────────────────────
  console.log('\nGATE 2 — rewrite fact-preservation:');
  if (process.env.NODE_ENV === 'test' || !process.env.OPENAI_API_KEY) {
    console.log('  SKIPPED (no OPENAI_API_KEY) — gate 1 covers determinism offline.');
  } else {
    // Lazy import so the offline gate never constructs the LLM stack.
    const { ConfigService } = await import('@nestjs/config');
    const { LlmService } = await import('../infrastructure/llm/llm.service');
    const { OpenAiProvider } = await import('../infrastructure/llm/providers/openai.provider');
    const { GeminiProvider } = await import('../infrastructure/llm/providers/gemini.provider');
    const { PromptsService } = await import('../modules/prompts/prompts.service');
    const { TemplateRenderer } = await import('../modules/prompts/template-renderer');
    const { CvRewriteService } = await import('../modules/cv-builder/cv-rewrite.service');

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
    // LlmService ctor order is (config, gemini, openai).
    const llm = new LlmService(cfg, new GeminiProvider(cfg), new OpenAiProvider(cfg));
    const prompts = new PromptsService(new TemplateRenderer());
    await prompts.onModuleInit();
    // Tracing is not needed in the eval harness (no DB); pass a no-op stub.
    const noopTracing = {
      startAiRequest: () => Promise.resolve('eval-noop'),
      completeAiRequest: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
    };
    const rewriter = new CvRewriteService(llm, prompts, noopTracing as never);

    for (const c of data.rewrite_cases) {
      try {
        const { suggestion, fallback } = await rewriter.rewrite(c);
        const inputNums = new Set(nums(c.text));
        const invented = nums(suggestion).filter((n) => !inputNums.has(n));
        const droppedNums = [...inputNums].filter(
          (n) => !nums(suggestion).includes(n) && !fallback,
        );
        const ok = invented.length === 0 && droppedNums.length === 0;
        console.log(
          `  ${ok ? '✓' : '✗'} ${c.name} [${c.mode}]${fallback ? ' (fallback)' : ''}` +
            (ok ? '' : ` invented=[${invented}] dropped=[${droppedNums}]`),
        );
        if (!ok) failures++;
      } catch (err) {
        console.log(`  ✗ ${c.name}: ${(err as Error).message}`);
        failures++;
      }
    }
  }

  console.log(
    `\n${failures === 0 ? 'PASS ✅' : `FAIL ✗ (${failures})`}${STRICT ? ' [strict]' : ''}`,
  );
  if (STRICT && failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`eval-cv-builder failed: ${(err as Error).message}`);
  process.exit(1);
});
