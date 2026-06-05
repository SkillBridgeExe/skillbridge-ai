import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Jobs pool — foundation for top-5 job recommendations + skill-demand trend analytics
 * (design: docs/jd-pool-research.md, scope approved 2026-06-05).
 *
 * Provenance-first: jobs carry source_type/source_name/source_url/external_id so one pool
 * serves employer-posted (Business role), manually imported REAL postings, and the Tier-A
 * crawlers (ITviec/TopDev — robots-permissive). LEGAL POSTURE baked into the schema:
 * we deliberately store NO full JD text — only extracted skills (job_skills), metadata, and
 * the canonical link back to the source (copyright-thin + PDPL-91/2025-safe; PII is scrubbed
 * upstream in the ingest pipeline before anything reaches these tables).
 *
 * Freshness model: last_seen_at bumped on every crawl that still sees the posting;
 * expires_at = source expiry or derived TTL; ghost jobs flip status→'expired' (kept for
 * trend history, filtered out of recommendations).
 *
 * job_embeddings mirrors skill_embeddings: one dense vector per job (its canonical
 * skill-set text), tagged with the FULL embedding tuple — same geometry as the CV side,
 * fused with the deterministic MATCH_TUNING score via RRF at query time. NO vector index
 * by design at pool sizes < a few thousand rows (exact scan, perfect recall).
 *
 * skill_demand_snapshots: nightly materialized counts per (skill, role, period) powering
 * "top skills theo role" / emerging-skills / CV-gap upskilling suggestions.
 *
 * NOTE (ts ordering): remote migrations top out at 1780500000000 (R2SkillEmbeddings);
 * this one is deliberately greater. RLS: rls_auto_enable force-enables on new tables;
 * the NestJS `postgres` role bypasses (same posture as every other app table).
 */
export class JobsPool1780510000000 implements MigrationInterface {
  name = 'JobsPool1780510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.companies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(255) NOT NULL,
        name_normalized varchar(255) NOT NULL,
        canonical_company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
        website varchar(512),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT uq_companies_name_normalized UNIQUE (name_normalized)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_companies_canonical ON public.companies (canonical_company_id);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
        created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        title varchar(255) NOT NULL,
        role_code varchar(64),
        location varchar(255),
        employment_type varchar(32),
        experience_level varchar(32),
        salary_min numeric(12,2),
        salary_max numeric(12,2),
        currency varchar(8) NOT NULL DEFAULT 'VND',
        status varchar(16) NOT NULL DEFAULT 'active',
        source_type varchar(16) NOT NULL,
        source_name varchar(64),
        source_url text,
        external_id varchar(255),
        content_hash varchar(64),
        canonical_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
        posted_at timestamptz,
        last_seen_at timestamptz,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT uq_jobs_source_external UNIQUE (source_name, external_id),
        CONSTRAINT chk_jobs_status CHECK (status IN ('active', 'expired', 'draft', 'removed')),
        CONSTRAINT chk_jobs_source_type CHECK (source_type IN ('employer', 'scraped', 'imported', 'feed')),
        CONSTRAINT chk_jobs_employment_type CHECK (employment_type IS NULL OR employment_type IN ('FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT', 'FREELANCE')),
        CONSTRAINT chk_jobs_experience_level CHECK (experience_level IS NULL OR experience_level IN ('INTERN', 'FRESHER', 'JUNIOR', 'MIDDLE', 'SENIOR', 'LEAD'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jobs_company ON public.jobs (company_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jobs_created_by ON public.jobs (created_by_user_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jobs_status_posted ON public.jobs (status, posted_at);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jobs_role_code ON public.jobs (role_code);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jobs_source_type ON public.jobs (source_type);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jobs_canonical ON public.jobs (canonical_job_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jobs_expires ON public.jobs (expires_at);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.job_skills (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
        skill_id uuid NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
        importance varchar(16) NOT NULL DEFAULT 'REQUIRED',
        min_level int,
        confidence numeric(5,2),
        raw_text varchar(255),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_job_skills UNIQUE (job_id, skill_id),
        CONSTRAINT chk_job_skills_importance CHECK (importance IN ('REQUIRED', 'PREFERRED', 'NICE_TO_HAVE'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_job_skills_job ON public.job_skills (job_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_job_skills_skill ON public.job_skills (skill_id);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.job_embeddings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
        embedding extensions.vector(1024) NOT NULL,
        source_text text NOT NULL,
        model varchar(64) NOT NULL,
        dimensions int NOT NULL,
        embedding_version varchar(16) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_job_embeddings UNIQUE (job_id, model, dimensions, embedding_version)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_job_embeddings_job ON public.job_embeddings (job_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_job_embeddings_tuple ON public.job_embeddings (model, dimensions, embedding_version);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.skill_demand_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        skill_id uuid NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
        role_code varchar(64) NOT NULL DEFAULT 'all',
        period date NOT NULL,
        posting_count int NOT NULL,
        pct_of_postings numeric(5,2),
        salary_p50 numeric(12,2),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_skill_demand UNIQUE (skill_id, role_code, period)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_demand_skill ON public.skill_demand_snapshots (skill_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_demand_period ON public.skill_demand_snapshots (period);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_demand_role ON public.skill_demand_snapshots (role_code);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.ingest_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_name varchar(64) NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        status varchar(16) NOT NULL DEFAULT 'running',
        fetched_count int NOT NULL DEFAULT 0,
        new_count int NOT NULL DEFAULT 0,
        updated_count int NOT NULL DEFAULT 0,
        expired_count int NOT NULL DEFAULT 0,
        error_text text,
        CONSTRAINT chk_ingest_runs_status CHECK (status IN ('running', 'success', 'failed'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_ingest_runs_source ON public.ingest_runs (source_name, started_at);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.ingest_runs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.skill_demand_snapshots;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.job_embeddings;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.job_skills;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.jobs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.companies;`);
  }
}
