/**
 * READ-ONLY role-drift report for the ai_app_engineer routing change.
 * Compares each job's CURRENTLY-STORED `role_code` against the NEW `classifyRole(title)` and reports
 * how many rows WOULD re-classify (old -> new), highlighting ai_ml_engineer -> ai_app_engineer.
 *
 * Does NOT write to the DB and does NOT backfill (that is a separate market-hardening PR).
 * Needs a reachable jobs DB; no-ops with a message otherwise. Usage:  pnpm report:role-drift
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import { classifyRole } from '../modules/jobs/ingest/ingest-normalizers';

async function main(): Promise<void> {
  try {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../app.module');
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    const ds = app.get(getDataSourceToken());

    // Read-only: title + currently-stored role_code from public.jobs.
    const rows: Array<{ title: string | null; role_code: string | null }> = await ds.query(
      'SELECT title, role_code FROM jobs',
    );

    const drift = new Map<string, number>();
    let changed = 0;
    for (const r of rows) {
      const next = classifyRole(r.title ?? '');
      if (next && next !== r.role_code) {
        changed++;
        const key = `${r.role_code ?? 'null'} -> ${next}`;
        drift.set(key, (drift.get(key) ?? 0) + 1);
      }
    }

    console.log(
      `\nRole-drift report (READ-ONLY, no DB writes) — ${rows.length} jobs, ${changed} would re-classify:`,
    );
    for (const [k, v] of [...drift.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
    const toAiApp = [...drift.entries()]
      .filter(([k]) => k.endsWith('-> ai_app_engineer'))
      .reduce((s, [, v]) => s + v, 0);
    console.log(`\n  → ai_app_engineer total: ${toAiApp}`);
    console.log('  (Apply via a separate backfill PR — this report does NOT modify the DB.)');
    await app.close();
  } catch (e) {
    console.log(
      `\nrole-drift: DB not available (${(e as Error).message}). The offline title-matrix test ` +
        `(classify-role-ai-app.spec.ts) is the mandatory drift evidence; run this with a reachable ` +
        `jobs DB to get live pool counts.`,
    );
  }
}

void main();
