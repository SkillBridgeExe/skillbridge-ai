import * as dotenv from 'dotenv';
import {
  classifyWorkMode,
  JobWorkMode,
  normalizeJobLocation,
} from '../modules/jobs/ingest/ingest-normalizers';

export interface JobMetadataBackfillRow {
  id: string;
  title: string | null;
  location: string | null;
  primary_city_code: string | null;
  location_city_codes: string[] | null;
  work_mode: string | null;
}

export interface JobMetadataBackfillChange {
  id: string;
  title: string;
  primaryCityCode?: string;
  cityCodes?: string[];
  workMode?: JobWorkMode;
}

/** Fill only missing normalized metadata. Explicit recruiter/crawler values always win. */
export function computeJobMetadataBackfill(
  jobs: JobMetadataBackfillRow[],
): JobMetadataBackfillChange[] {
  const changes: JobMetadataBackfillChange[] = [];
  for (const job of jobs) {
    const normalizedLocation = normalizeJobLocation(job.location ?? '');
    const storedCities = job.location_city_codes ?? [];
    const locationMissing = !job.primary_city_code && storedCities.length === 0;
    const workModeMissing = !(job.work_mode ?? '').trim();
    const next: JobMetadataBackfillChange = {
      id: job.id,
      title: job.title ?? '',
    };

    if (locationMissing && normalizedLocation.cityCodes.length > 0) {
      next.primaryCityCode = normalizedLocation.primaryCityCode ?? undefined;
      next.cityCodes = normalizedLocation.cityCodes;
    }
    if (workModeMissing) {
      next.workMode = classifyWorkMode(`${job.title ?? ''} ${job.location ?? ''}`) ?? undefined;
    }
    if (next.cityCodes || next.workMode) changes.push(next);
  }
  return changes;
}

/** Execute the UPDATE in the DB safely without destroying existing metadata. */
export async function applyJobMetadataBackfill(
  manager: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  changes: JobMetadataBackfillChange[],
): Promise<void> {
  for (const change of changes) {
    await manager.query(
      `UPDATE jobs
          SET primary_city_code = CASE
                WHEN primary_city_code IS NULL
                 AND COALESCE(cardinality(location_city_codes), 0) = 0
                THEN $1 ELSE primary_city_code END,
              location_city_codes = CASE
                WHEN primary_city_code IS NULL
                 AND COALESCE(cardinality(location_city_codes), 0) = 0
                THEN $2 ELSE location_city_codes END,
              work_mode = COALESCE(NULLIF(BTRIM(work_mode), ''), $3),
              updated_at = now()
        WHERE id = $4`,
      [change.primaryCityCode ?? null, change.cityCodes ?? [], change.workMode ?? null, change.id],
    );
  }
}

/**
 * Default is read-only. `--apply` updates only currently-empty metadata in one transaction.
 *
 *   pnpm backfill:job-metadata
 *   pnpm backfill:job-metadata -- --apply
 */
async function main(): Promise<void> {
  dotenv.config();
  const apply = process.argv.includes('--apply');
  const { Client } = await import('pg');
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'skillbridge',
  });

  try {
    await client.connect();

    // Guard: Prevent accidentally running migrations by NOT booting AppModule
    const result = await client.query(
      `SELECT id, title, location, primary_city_code, location_city_codes, work_mode
         FROM jobs
        WHERE status = 'active' AND canonical_job_id IS NULL
        ORDER BY id`,
    );
    const jobs: JobMetadataBackfillRow[] = result.rows;

    const changes = computeJobMetadataBackfill(jobs);
    const withLocation = changes.filter((change) => change.cityCodes).length;
    const withWorkMode = changes.filter((change) => change.workMode).length;

    console.log(
      `\njob metadata backfill — ${jobs.length} active canonical jobs, ${changes.length} changes ` +
        `${apply ? '(APPLYING)' : '(DRY-RUN — no writes)'}`,
    );
    console.log(`  location codes: ${withLocation}`);
    console.log(`  work modes: ${withWorkMode}`);
    console.log('\n  id | title | city codes | work mode');
    for (const change of changes) {
      console.log(
        `  ${change.id} | ${change.title} | ${change.cityCodes?.join(',') ?? '-'} | ` +
          `${change.workMode ?? '-'}`,
      );
    }

    if (apply && changes.length > 0) {
      await client.query('BEGIN');
      try {
        await applyJobMetadataBackfill(client, changes);
        await client.query('COMMIT');
        console.log(`\nAPPLIED ${changes.length} rows in one transaction.`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } else if (apply) {
      console.log('\nNothing to apply.');
    } else {
      console.log('\nDRY-RUN only. Re-run with `-- --apply` after explicit approval.');
    }
  } catch (error) {
    console.log(`\nbackfill: DB not available (${(error as Error).message}).`);
    process.exitCode = 1;
  } finally {
    // Best-effort cleanup to prevent connection pool leaks
    await client.end().catch(() => {});
  }
}

if (require.main === module) void main();
