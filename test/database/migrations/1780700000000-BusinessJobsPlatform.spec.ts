import { QueryRunner } from 'typeorm';
import { BusinessJobsPlatform1780700000000 } from '../../../src/database/migrations/1780700000000-BusinessJobsPlatform';

describe('BusinessJobsPlatform1780700000000', () => {
  it('creates exactly the six approved business-job tables', async () => {
    const sql = (await collectUpQueries()).join('\n');
    for (const table of [
      'business_profiles',
      'job_post_versions',
      'saved_jobs',
      'job_applications',
      'job_application_status_events',
      'job_reports',
    ]) {
      expect(sql).toContain(`CREATE TABLE public.${table}`);
    }
  });

  it('enforces one draft per job and one application per candidate and job', async () => {
    const sql = (await collectUpQueries()).join('\n');
    expect(sql).toContain('uq_job_post_versions_one_draft');
    expect(sql).toContain("WHERE status = 'DRAFT'");
    expect(sql).toContain('UNIQUE (job_id, candidate_user_id)');
  });

  it('adds a GIN index for multi-city discovery and the published-version foreign key', async () => {
    const sql = (await collectUpQueries()).join('\n');
    expect(sql).toContain('USING gin (location_city_codes)');
    expect(sql).toContain('fk_jobs_current_published_version');
    expect(sql.indexOf('CREATE TABLE public.job_post_versions')).toBeLessThan(
      sql.indexOf('fk_jobs_current_published_version'),
    );
  });

  it('keeps legacy crawler inserts valid with database defaults', async () => {
    const sql = (await collectUpQueries()).join('\n');
    expect(sql).toContain('ALTER COLUMN slug SET DEFAULT gen_random_uuid()::text');
    expect(sql).toContain("ALTER COLUMN application_mode SET DEFAULT 'EXTERNAL'");
  });

  it('makes published snapshots immutable while allowing them to be superseded', async () => {
    const sql = (await collectUpQueries()).join('\n');
    expect(sql).toContain('protect_published_job_version');
    expect(sql).toContain("OLD.status IN ('PUBLISHED', 'SUPERSEDED')");
    expect(sql).toContain("OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED'");
  });

  it('normalizes closed jobs before restoring the legacy status constraint on rollback', async () => {
    const sql = (await collectDownQueries()).join('\n');
    const normalizeAt = sql.indexOf("SET status = 'expired' WHERE status = 'closed'");
    const constraintAt = sql.indexOf("CHECK (status IN ('active', 'expired', 'draft', 'removed'))");
    expect(normalizeAt).toBeGreaterThanOrEqual(0);
    expect(normalizeAt).toBeLessThan(constraintAt);
  });
});

async function collectUpQueries(): Promise<string[]> {
  const queries: string[] = [];
  const runner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;
  await new BusinessJobsPlatform1780700000000().up(runner);
  return queries;
}

async function collectDownQueries(): Promise<string[]> {
  const queries: string[] = [];
  const runner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;
  await new BusinessJobsPlatform1780700000000().down(runner);
  return queries;
}
