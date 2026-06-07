/**
 * CV-scorer ACCURACY harness — validates the LLM rubric scores against an expert-criteria
 * grounded labeled set (`data/eval-cvs.json`), WITHOUT human raters.
 *
 *   pnpm eval:accuracy
 *   EVAL_DELAY_MS=25000 pnpm eval:accuracy   # throttle if the provider rate-limits
 *
 * Each eval CV has an EXPECTED BAND [min,max] per dimension (Fresno State 4-level model;
 * criteria sourced in docs/cv-scoring-methodology.md). The calibration spine reports:
 *   - within-band % (exact) + within-±3 (soft) — per dimension AND overall
 *   - MAE (mean abs error vs band midpoint) — per dimension AND overall
 *   - Spearman rank-correlation of predicted overall vs expected overall — can the scorer
 *     ORDER CVs correctly? (the key property for roadmap prioritization)
 * Bands are what the sources define, so band-agreement + ranking matter more than point precision.
 * This is a proxy for accuracy, NOT a substitute for human labels.
 *
 * Runs DB-less (NODE_ENV=test → tracing stub) — it measures scoring, not persistence.
 * Needs OPENAI_API_KEY (provider = LLM_PROVIDER_DEFAULT, default openai — NOT Gemini).
 * Each CV = 2 LLM calls (parse + rubric), so N CVs = 2N calls.
 */
import * as dotenv from 'dotenv';
// SURGICAL override: a stale OS-level OPENAI_API_KEY can shadow .env (known Windows gotcha) —
// for a billing-relevant eval the .env key is the contract. Force only that one var.
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import * as fs from 'fs';
import * as path from 'path';
import { mae, spearman, mean } from './calibration-stats';

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
const SPEARMAN_MIN = Number(process.env.EVAL_SPEARMAN_MIN ?? 0.6); // ranking sanity floor
const PROMPT_CODE = 'cv_review_v1';
const LIMIT = Number(process.env.EVAL_LIMIT ?? 0); // >0 = only first N CVs (fits free-tier 20/day cap)

const bandMid = ([lo, hi]: [number, number]): number => (lo + hi) / 2;
const inBand = (x: number, [lo, hi]: [number, number]): boolean => x >= lo && x <= hi;
const near = (x: number, [lo, hi]: [number, number]): boolean => x >= lo - 3 && x <= hi + 3;
const pct = (a: number, b: number): string => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-cvs.json');
  const { cvs: allCvs } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cvs: EvalCv[] };
  const cvs = LIMIT > 0 ? allCvs.slice(0, LIMIT) : allCvs;

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { CvReviewService } = await import('../modules/cv-review/cv-review.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const cvReview = app.get(CvReviewService);

  console.log(
    `\nAccuracy eval — ${cvs.length} CVs × ${DIMS.length} dims (within-band target ${Math.round(ACCEPT_RATE * 100)}%, Spearman ≥ ${SPEARMAN_MIN})\n`,
  );

  // Per-dimension accumulators + per-CV overall arrays (for ranking).
  const perDim: Record<Dim, { pred: number[]; expMid: number[]; inBand: number; near: number }> = {
    action_verbs: { pred: [], expMid: [], inBand: 0, near: 0 },
    skills_relevance: { pred: [], expMid: [], inBand: 0, near: 0 },
    experience: { pred: [], expMid: [], inBand: 0, near: 0 },
    education: { pred: [], expMid: [], inBand: 0, near: 0 },
  };
  const predOverall: number[] = [];
  const expOverall: number[] = []; // monotonic proxy = sum of dim band midpoints
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
      const band = cv.expected[d];
      perDim[d].pred.push(score);
      perDim[d].expMid.push(bandMid(band));
      if (inBand(score, band)) perDim[d].inBand += 1;
      if (near(score, band)) perDim[d].near += 1;
      if (!inBand(score, band)) {
        const delta = score < band[0] ? score - band[0] : score - band[1];
        fails.push(
          `  ${cv.id.padEnd(24)} ${d.padEnd(16)} got ${score}, expected ${band[0]}-${band[1]} (off ${delta > 0 ? '+' : ''}${delta})`,
        );
      }
    }
    predOverall.push(res.total_score);
    expOverall.push(DIMS.reduce((s, d) => s + bandMid(cv.expected[d]), 0));

    console.log(
      `${cv.id.padEnd(24)} ${DIMS.map((d) => `${d.slice(0, 4)}=${String(dims[d]).padStart(2)}`).join('  ')}  overall=${res.total_score}`,
    );
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  await app.close();

  const N = cvs.length;
  let totIn = 0;
  let totNear = 0;
  let totCount = 0;
  console.log('\n=== Per-dimension (within-band / within±3 / MAE) ===');
  for (const d of DIMS) {
    const p = perDim[d];
    totIn += p.inBand;
    totNear += p.near;
    totCount += N;
    console.log(
      `${d.padEnd(16)} band ${pct(p.inBand, N)}  ±3 ${pct(p.near, N)}  MAE ${mae(p.pred, p.expMid)}`,
    );
  }

  const overallMae = mae(
    DIMS.flatMap((d) => perDim[d].pred),
    DIMS.flatMap((d) => perDim[d].expMid),
  );
  const rho = spearman(predOverall, expOverall);
  const rate = totIn / totCount;

  console.log('\n=== Overall ===');
  console.log(`within-band : ${totIn}/${totCount} (${Math.round(rate * 100)}%)`);
  console.log(`within ±3   : ${totNear}/${totCount} (${Math.round((totNear / totCount) * 100)}%)`);
  console.log(`MAE (per-dim pts) : ${overallMae}`);
  console.log(
    `Spearman (ranking, overall) : ${rho}  [mean predicted=${Math.round(mean(predOverall))}]`,
  );
  if (fails.length) {
    console.log('\nOut-of-band:');
    console.log(fails.join('\n'));
  }

  const pass = rate >= ACCEPT_RATE && rho >= SPEARMAN_MIN;
  console.log(
    `\nVerdict: ${pass ? 'PASS ✅' : 'FAIL ❌'} (within-band ${Math.round(rate * 100)}% / target ${Math.round(ACCEPT_RATE * 100)}%, Spearman ${rho} / min ${SPEARMAN_MIN})\n`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('\nAccuracy eval failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
