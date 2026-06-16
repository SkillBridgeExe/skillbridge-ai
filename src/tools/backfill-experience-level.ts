import * as dotenv from 'dotenv';
import { classifySeniority, SeniorityLevel } from '../modules/jobs/ingest/ingest-normalizers';

export interface SeniorityBackfillChange {
  id: string;
  title: string;
  to: SeniorityLevel;
}

/**
 * Rule: fill iff the job's experience_level is NULL/empty AND classifySeniority(title) is non-null.
 * Conservative — only fills the gap (the prod cause: ~0/803 active jobs had experience_level while
 * 34% are SENIOR/LEAD by title). Never OVERRIDES an explicit stored value. Active jobs only is the
 * caller's filter (query below); the rule itself is pure + idempotent (re-running fills nothing new).
 */
export function computeSeniorityBackfill(
  jobs: Array<{ id: string; title: string | null; experience_level: string | null }>,
): SeniorityBackfillChange[] {
  const out: SeniorityBackfillChange[] = [];
  for (const j of jobs) {
    const stored = (j.experience_level ?? '').trim();
    if (stored.length > 0) continue; // never override an explicit value
    const next = classifySeniority(j.title ?? '');
    if (next !== null) out.push({ id: j.id, title: j.title ?? '', to: next });
  }
  return out;
}

/**
 * CLI. Default = DRY-RUN (counts + id|title|→level, NO writes). `--apply` writes experience_level
 * (only) for the computed changes in one transaction. Idempotent; fills NULLs only.
 * Usage:  pnpm backfill:experience-level              (dry-run)
 *         pnpm backfill:experience-level -- --apply   (write, after explicit approval)
 */
async function main(): Promise<void> {
  const dotenvParsed = dotenv.config().parsed ?? {};
  if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
  const apply = process.argv.includes('--apply');
  try {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../app.module');
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    const ds = app.get(getDataSourceToken());

    // Active, canonical representatives (the pool the job-rec guard actually reads), missing the field.
    const jobs: Array<{ id: string; title: string | null; experience_level: string | null }> =
      await ds.query(
        `SELECT id, title, experience_level FROM jobs
          WHERE status = 'active' AND canonical_job_id IS NULL AND experience_level IS NULL`,
      );
    const changes = computeSeniorityBackfill(jobs);

    const counts = new Map<string, number>();
    for (const c of changes) counts.set(c.to, (counts.get(c.to) ?? 0) + 1);
    console.log(
      `\nexperience_level backfill — ${jobs.length} null-level active jobs, ${changes.length} fillable ` +
        `${apply ? '(APPLYING)' : '(DRY-RUN — no writes)'}`,
    );
    for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
    console.log(`  (left NULL — no clear title level: ${jobs.length - changes.length})`);
    console.log('\n  id | title | -> level');
    for (const c of changes) console.log(`  ${c.id} | ${c.title} | -> ${c.to}`);

    if (apply && changes.length) {
      await ds.transaction(
        async (mgr: { query: (q: string, p: unknown[]) => Promise<unknown> }) => {
          for (const c of changes) {
            await mgr.query('UPDATE jobs SET experience_level = $1 WHERE id = $2', [c.to, c.id]);
          }
        },
      );
      console.log(
        `\nAPPLIED ${changes.length} updates in one transaction (experience_level only).`,
      );
    } else if (apply) {
      console.log('\nNothing to apply (0 changes).');
    } else {
      console.log('\nDRY-RUN only. Re-run with `-- --apply` to write (after explicit approval).');
    }
    await app.close();
  } catch (e) {
    console.log(
      `\nbackfill: DB not available (${(e as Error).message}). Needs a reachable jobs DB.`,
    );
  }
}

if (require.main === module) void main();
