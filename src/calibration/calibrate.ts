/**
 * CV-review calibration harness.
 *
 *   pnpm calibrate              # uses LLM_PROVIDER_DEFAULT (gemini) from .env
 *   CALIBRATION_REPS=5 pnpm calibrate
 *   LLM_PROVIDER_DEFAULT=openai pnpm calibrate   # compare providers (delta target < 8)
 *
 * Scores each sample CV (data/calibration-cvs.json) REPS times with the SAME input
 * and reports per-CV sample stddev(overall_score). Acceptance: stddev < 5.
 *
 * Boots the AI side WITHOUT a database: NODE_ENV=test makes AppModule skip the
 * TypeORM + platform modules (see app.module.ts), and cv-review's deps
 * (LlmService, PromptsService, TracingService[stub], common services) don't touch
 * the DB. Requires GEMINI_API_KEY (or OPENAI_API_KEY) in .env to actually call the model.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import type { CvReviewRequestDto } from '../modules/cv-review/dto/cv-review-request.dto';
import { CvRunResult, summarizeCv, overallVerdict } from './calibration-stats';

// MUST run before AppModule is imported — it reads NODE_ENV at module-eval time.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

const REPS = Number(process.env.CALIBRATION_REPS ?? 5);
// Free-tier Gemini ≈ 5 req/min; each review = 2 LLM calls. Set CALIBRATION_DELAY_MS
// (e.g. 25000) to pace under the quota. Default 0 = no throttle (paid keys / OpenAI).
const DELAY_MS = Number(process.env.CALIBRATION_DELAY_MS ?? 0);
const LIMIT = Number(process.env.CALIBRATION_LIMIT ?? 0); // >0 = only first N CVs (quick check)
const PROMPT_CODE = 'cv_review_v1';

interface SampleCv {
  id: string;
  target_role: string;
  parsed_text: string;
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'calibration-cvs.json');
  const { cvs } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cvs: SampleCv[] };
  const provider = process.env.LLM_PROVIDER_DEFAULT ?? 'gemini';

  // Dynamic import AFTER NODE_ENV is set, so AppModule evaluates with the test guard.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { CvReviewService } = await import('../modules/cv-review/cv-review.service');

  const list = LIMIT > 0 ? cvs.slice(0, LIMIT) : cvs;
  console.log(`\nCalibration — ${list.length} CVs × ${REPS} reps · provider=${provider}\n`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const cvReview = app.get(CvReviewService);

  const results: CvRunResult[] = [];
  let totalTokens = 0;
  let totalLatencyMs = 0;
  let calls = 0;

  for (const cv of list) {
    const scores: number[] = [];
    for (let i = 0; i < REPS; i++) {
      const input: CvReviewRequestDto = {
        cv_id: cv.id,
        parsed_text: cv.parsed_text,
        prompt_template_code: PROMPT_CODE,
        target_role: cv.target_role,
      };
      const res = await cvReview.review('calibration', input);
      scores.push(res.total_score);
      totalTokens += res.token_usage ?? 0;
      totalLatencyMs += res.latency_ms ?? 0;
      calls += 1;
      process.stdout.write('.');
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    results.push({ id: cv.id, targetRole: cv.target_role, scores });
    console.log(`  ${cv.id} → [${scores.join(', ')}]`);
  }

  await app.close();

  console.log('\n=== Per-CV (target stddev < 5) ===');
  const stats = results.map((r) => summarizeCv(r));
  for (const s of stats) {
    console.log(
      `${s.pass ? 'PASS' : 'FAIL'}  ${s.id.padEnd(16)} role=${s.targetRole.padEnd(20)} mean=${s.mean} stddev=${s.stddev} [${s.min}-${s.max}]`,
    );
  }

  const v = overallVerdict(stats);
  console.log('\n=== Verdict ===');
  console.log(
    `provider=${provider} · maxStddev=${v.maxStddev} · ${v.pass ? 'PASS ✅' : 'FAIL ❌ (' + v.failed.join(', ') + ')'}`,
  );
  console.log(
    `calls=${calls} · tokens=${totalTokens} · avgLatency=${Math.round(totalLatencyMs / calls)}ms`,
  );
  console.log(
    'Tip: run with LLM_PROVIDER_DEFAULT=openai to compare providers (mean delta target < 8).\n',
  );

  process.exit(v.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('\nCalibration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
