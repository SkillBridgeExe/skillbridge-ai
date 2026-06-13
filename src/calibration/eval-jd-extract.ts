/**
 * JD-extraction ACCURACY harness (Tier B) — the FIRST eval of the LLM EXTRACTION step itself, for the
 * one dimension PR3 grades: seniority. The deterministic mapping/severity is already gated offline by
 * eval:gap + the jest specs; this measures whether the cv_jd_match_v2 prompt correctly reads (or
 * correctly DOESN'T fabricate) a seniority requirement from real bilingual JD prose.
 *
 *   pnpm eval:jd-extract                       # report-only
 *   EVAL_JD_EXTRACT_STRICT=1 pnpm eval:jd-extract   # gate: recall ≥ 0.8 AND false-positive ≤ 0.1
 *
 * Two metrics over data/eval-jd-extract-cases.json:
 *   - recall (level match): of the JDs that STATE a seniority level, how many did we extract at the
 *     correct level_hint?
 *   - false-positive rate (the HONESTY metric): of the JDs that state NO seniority, how many did we
 *     wrongly invent one? (must stay low — fabricating a seniority gap is the failure we most fear.)
 *
 * NOT in CI / `pnpm test` (it calls the real LLM → non-deterministic, billable). Opt-in / nightly /
 * pre-flip. Anti-flakiness: temperature 0.1 + jsonMode, thresholds over the WHOLE set (not per-case).
 * Run this GREEN before flipping the production scoring_template_code to cv_jd_match_v2.
 */
import * as dotenv from 'dotenv';
// Same surgical override as eval-accuracy: a stale OS-level key must not shadow the .env contract.
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import * as fs from 'fs';
import * as path from 'path';
import { normalizeJdDimensions } from '../modules/gap-engine/jd-dimensions';
import { withRetry } from './retry';

// DB-less mode (tracing stub) BEFORE AppModule is imported — we measure extraction, not persistence.
process.env.NODE_ENV = 'test';

interface JdExtractCase {
  id: string;
  jd_text: string;
  cv_text?: string;
  /** Golden seniority the JD states; level_hint null = the JD states NO seniority (a negative case). */
  expect_seniority: { level_hint: string | null };
}

const STRICT = process.env.EVAL_JD_EXTRACT_STRICT === '1';
const RECALL_MIN = Number(process.env.EVAL_JD_RECALL_MIN ?? 0.8);
const FP_MAX = Number(process.env.EVAL_JD_FP_MAX ?? 0.1);
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 3000);
const PROMPT_CODE = 'cv_jd_match_v2';
const DEFAULT_CV = 'Backend developer with experience in Node.js, SQL and Git at a startup.';

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-jd-extract-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: JdExtractCase[] };

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { LlmService } = await import('../infrastructure/llm/llm.service');
  const { PromptsService } = await import('../modules/prompts/prompts.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const llm = app.get(LlmService);
  const prompts = app.get(PromptsService);
  const template = prompts.get(PROMPT_CODE);

  console.log(
    `\nJD-extraction eval (Tier B, LLM) — ${cases.length} cases${STRICT ? ' [STRICT]' : ''}\n`,
  );

  let positives = 0;
  let hits = 0;
  let negatives = 0;
  let falsePositives = 0;
  const skipped: string[] = [];
  const lines: string[] = [];

  for (const c of cases) {
    const user = prompts.render(PROMPT_CODE, {
      cv_text: c.cv_text ?? DEFAULT_CV,
      jd_text: c.jd_text,
    });
    let parsedJson: unknown;
    try {
      const res = await withRetry(
        () =>
          llm.complete(
            [
              { role: 'system', content: template.meta.system ?? '' },
              { role: 'user', content: user },
            ],
            { jsonMode: true, temperature: 0.1, maxOutputTokens: 3000 },
          ),
        2,
        (e, n) => console.warn(`  ${c.id}: retry ${n} — ${(e as Error).message}`),
      );
      parsedJson = res.parsedJson;
    } catch (e) {
      console.warn(`  ${c.id}: SKIPPED — ${(e as Error).message}`);
      skipped.push(c.id);
      continue;
    }

    const obj = (parsedJson && typeof parsedJson === 'object' ? parsedJson : {}) as Record<
      string,
      unknown
    >;
    const seniority = normalizeJdDimensions(obj.jd_dimensions_raw).find(
      (d) => d.dimension === 'seniority',
    );
    const extracted = seniority?.level_hint ?? null;
    const expected = c.expect_seniority.level_hint;

    if (expected === null) {
      negatives += 1;
      const fp = extracted !== null;
      if (fp) falsePositives += 1;
      lines.push(
        `  ${c.id.padEnd(28)} expect=NONE   got=${(extracted ?? 'none').padEnd(8)} ${fp ? 'FALSE-POSITIVE ✗' : '✓'}`,
      );
    } else {
      positives += 1;
      const hit = extracted === expected;
      if (hit) hits += 1;
      lines.push(
        `  ${c.id.padEnd(28)} expect=${expected.padEnd(8)} got=${(extracted ?? 'none').padEnd(8)} ${hit ? '✓' : '✗'}`,
      );
    }
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  await app.close();

  const recall = positives ? hits / positives : 1;
  const fpRate = negatives ? falsePositives / negatives : 0;
  console.log(lines.join('\n'));
  console.log('\n=== Summary ===');
  if (skipped.length) console.log(`skipped (transient): ${skipped.join(', ')}`);
  console.log(
    `recall (level match): ${hits}/${positives} = ${(recall * 100).toFixed(0)}%  [min ${(RECALL_MIN * 100).toFixed(0)}%]`,
  );
  console.log(
    `false-positive rate : ${falsePositives}/${negatives} = ${(fpRate * 100).toFixed(0)}%  [max ${(FP_MAX * 100).toFixed(0)}%]  (honesty)`,
  );
  // False-green guard: a strict gate must NOT pass if every positive case was skipped (transient
  // LLM errors) — recall would default to 1 while measuring nothing.
  const measured = positives > 0;
  const pass = measured && recall >= RECALL_MIN && fpRate <= FP_MAX;
  if (!measured) console.log('⚠️  no positive cases evaluated (all skipped?) — cannot certify');
  console.log(
    `\nVerdict: ${pass ? 'PASS ✅' : 'FAIL ❌'}${STRICT ? ' [strict]' : ' (report-only — set EVAL_JD_EXTRACT_STRICT=1 to gate)'}\n`,
  );
  process.exit(STRICT && !pass ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-jd-extract failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
