import * as dotenv from 'dotenv';
import { classifyRole } from '../modules/jobs/ingest/ingest-normalizers';

export interface RoleBackfillChange {
  id: string;
  title: string;
  from: string | null;
  to: string;
}

/** Rule: change iff classifyRole(title) is non-null AND differs from the stored role_code. */
export function computeRoleBackfill(
  jobs: Array<{ id: string; title: string | null; role_code: string | null }>,
): RoleBackfillChange[] {
  const out: RoleBackfillChange[] = [];
  for (const j of jobs) {
    const next = classifyRole(j.title ?? '');
    if (next !== null && next !== j.role_code) {
      out.push({ id: j.id, title: j.title ?? '', from: j.role_code, to: next });
    }
  }
  return out;
}

/**
 * CLI. Default = DRY-RUN (prints counts + id|title|old→new, NO writes). `--apply` writes role_code
 * (only) for the computed changes inside one transaction. Idempotent. Updates `role_code` ONLY.
 * Usage:  pnpm backfill:role-code        (dry-run)
 *         pnpm backfill:role-code -- --apply   (write, after explicit approval)
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

    const jobs: Array<{ id: string; title: string | null; role_code: string | null }> =
      await ds.query('SELECT id, title, role_code FROM jobs');
    const changes = computeRoleBackfill(jobs);

    const counts = new Map<string, number>();
    for (const c of changes) {
      const k = `${c.from ?? 'null'} -> ${c.to}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    console.log(
      `\nrole_code backfill — ${jobs.length} jobs, ${changes.length} changes ` +
        `${apply ? '(APPLYING)' : '(DRY-RUN — no writes)'}`,
    );
    for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
    console.log('\n  id | title | old -> new');
    for (const c of changes) {
      console.log(`  ${c.id} | ${c.title} | ${c.from ?? 'null'} -> ${c.to}`);
    }

    if (apply && changes.length) {
      await ds.transaction(
        async (mgr: { query: (q: string, p: unknown[]) => Promise<unknown> }) => {
          for (const c of changes) {
            await mgr.query('UPDATE jobs SET role_code = $1 WHERE id = $2', [c.to, c.id]);
          }
        },
      );
      console.log(`\nAPPLIED ${changes.length} updates in one transaction (role_code only).`);
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
