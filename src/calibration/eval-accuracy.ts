/**
 * CV-scorer ACCURACY harness — validates the LLM rubric scores against an expert-criteria
 * grounded labeled set (`data/eval-cvs.json`), WITHOUT human raters.
 *
 *   pnpm eval:accuracy
 *   EVAL_DELAY_MS=25000 pnpm eval:accuracy   # throttle for free-tier Gemini (20 req/day!)
 *
 * Each eval CV has an EXPECTED BAND [min,max] per dimension (Fresno State 4-level model;
 * criteria sourced in docs/cv-scoring-methodology.md). We score on WITHIN-BAND agreement
 * (and report within-1-band as a softer signal), NOT point precision — bands are what the
 * sources define. This is a proxy for accuracy, not a substitute for human labels.
 *
 * Runs DB-less (NODE_ENV=test → tracing stub) — it measures scoring, not persistence.
 * Needs GEMINI_API_KEY. Each CV = 2 LLM calls (parse + rubric), so N CVs = 2N calls.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

// Force DB-less scoring mode BEFORE AppModule is imported.
process.env.NODE_ENV = 'test';

const DIMS = ['action_verbs', 'skills_relevance', 'experience', 'education'] as const;
type Dim = (typeof DIMS)[number];

interface EvalCv {
  id: string;
  target_role: string;
  parsed_text: string;
  rationale: string;
  expected: Record<Dim, [number, number]>;
}

const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 4000);
const ACCEPT_RATE = Number(process.env.EVAL_ACCEPT_RATE ?? 0.8); // ≥80% within-band to PASS
const PROMPT_CODE = 'cv_review_v1';

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-cvs.json');
  const { cvs } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cvs: EvalCv[] };

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { CvReviewService } = await import('../modules/cv-review/cv-review.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const cvReview = app.get(CvReviewService);

  console.log(
    `\nAccuracy eval — ${cvs.length} CVs × ${DIMS.length} dims (within-band target ${Math.round(ACCEPT_RATE * 100)}%)\n`,
  );

  let total = 0;
  let inBand = 0;
  let within1 = 0; // within-1-band tolerance (±band width as a softer signal)
  const fails: string[] = [];

  for (const cv of cvs) {
    const res = await cvReview.review('eval', {
      cv_id: cv.id,
      parsed_text: cv.parsed_text,
      prompt_template_code: PROMPT_CODE,
      target_role: cv.target_role,
    });
    const dims = res.parsed_response.llm_score_dimensions as Record<Dim, number>;

    for (const d of DIMS) {
      const score = dims[d];
      const [lo, hi] = cv.expected[d];
      const ok = score >= lo && score <= hi;
      const near = score >= lo - 3 && score <= hi + 3; // ~half a 6-7pt band of slack
      total += 1;
      if (ok) inBand += 1;
      if (near) within1 += 1;
      if (!ok) {
        const delta = score < lo ? score - lo : score - hi;
        fails.push(
          `  ${cv.id.padEnd(22)} ${d.padEnd(16)} got ${score}, expected ${lo}-${hi} (off by ${delta > 0 ? '+' : ''}${delta})`,
        );
      }
    }
    console.log(
      `${cv.id.padEnd(22)} ${DIMS.map((d) => `${d.slice(0, 4)}=${String(dims[d]).padStart(2)}`).join('  ')}  overall=${res.total_score}`,
    );
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  await app.close();

  const rate = inBand / total;
  const nearRate = within1 / total;
  console.log('\n=== Accuracy (within expected band) ===');
  console.log(`exact band : ${inBand}/${total} (${Math.round(rate * 100)}%)`);
  console.log(`within ±3  : ${within1}/${total} (${Math.round(nearRate * 100)}%)`);
  if (fails.length) {
    console.log('\nOut-of-band:');
    console.log(fails.join('\n'));
  }
  console.log(
    `\nVerdict: ${rate >= ACCEPT_RATE ? 'PASS ✅' : 'FAIL ❌'} (target ${Math.round(ACCEPT_RATE * 100)}% within-band)\n`,
  );

  process.exit(rate >= ACCEPT_RATE ? 0 : 1);
}

main().catch((err) => {
  console.error('\nAccuracy eval failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
