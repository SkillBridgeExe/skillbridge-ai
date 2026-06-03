/**
 * R1 end-to-end tracing check — proves the REAL runtime path:
 *   cv-review → Gemini (2 LLM calls: parse + rubric) → composite score
 *   → TracingService writes ai_requests (PENDING→SUCCESS) + ai_results to the DB.
 *
 *   pnpm e2e:tracing
 *
 * Unlike `calibrate` (NODE_ENV=test, DB skipped, tracing stubbed), this forces the
 * full runtime: NODE_ENV=development → AppModule connects TypeORM + injects the
 * ai_requests/ai_results repos into TracingService. Requires a working DATABASE_URL
 * (Supabase session pooler) + GEMINI_API_KEY in .env.
 *
 * Prints the generated userId + ai_request_id so you can verify the rows
 * (SELECT * FROM ai_requests WHERE user_id = '<printed>').
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// Force the real path (DB + live tracing repos). Set BEFORE AppModule is imported.
process.env.NODE_ENV = 'development';

interface SampleCv {
  id: string;
  target_role: string;
  parsed_text: string;
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'calibration-cvs.json');
  const { cvs } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cvs: SampleCv[] };
  const sample = cvs[0];

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { CvReviewService } = await import('../modules/cv-review/cv-review.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const cvReview = app.get(CvReviewService);

  const userId = randomUUID();
  console.log(`\n=== E2E tracing check ===`);
  console.log(`sample CV : ${sample.id} (target_role=${sample.target_role})`);
  console.log(`userId    : ${userId}`);

  const t0 = Date.now();
  const res = await cvReview.review(userId, {
    cv_id: randomUUID(),
    parsed_text: sample.parsed_text,
    prompt_template_code: 'cv_review_v1',
    target_role: sample.target_role,
  });
  const wallMs = Date.now() - t0;

  console.log(`\n--- result ---`);
  console.log(`ai_request_id : ${res.ai_request_id}`);
  console.log(`total_score   : ${res.total_score}`);
  console.log(`model_code    : ${res.model_code}`);
  console.log(`token_usage   : ${res.token_usage}`);
  console.log(`confidence    : ${res.confidence_score}`);
  console.log(`llm latency   : ${res.latency_ms}ms · wall ${wallMs}ms`);
  console.log(`\nVerify rows:\n  SELECT * FROM ai_requests WHERE user_id = '${userId}';`);
  console.log(`  SELECT * FROM ai_results  WHERE user_id = '${userId}';`);

  await app.close();
}

main().catch((err) => {
  console.error('\nE2E tracing check failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
