import { MigrationInterface, QueryRunner } from 'typeorm';

export class BusinessJobsPlatform1780700000000 implements MigrationInterface {
  name = 'BusinessJobsPlatform1780700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.verifications
        ADD COLUMN IF NOT EXISTS target_value_hash varchar(64);

      ALTER TABLE public.companies
        ADD COLUMN IF NOT EXISTS slug varchar(320),
        ADD COLUMN IF NOT EXISTS logo_object_key text,
        ADD COLUMN IF NOT EXISTS cover_object_key text,
        ADD COLUMN IF NOT EXISTS linkedin_url text,
        ADD COLUMN IF NOT EXISTS industry_code varchar(64),
        ADD COLUMN IF NOT EXISTS company_type varchar(32),
        ADD COLUMN IF NOT EXISTS company_size varchar(32),
        ADD COLUMN IF NOT EXISTS founded_year smallint,
        ADD COLUMN IF NOT EXISTS country_code varchar(2) NOT NULL DEFAULT 'VN',
        ADD COLUMN IF NOT EXISTS headquarters_city_code varchar(64),
        ADD COLUMN IF NOT EXISTS headquarters_address text,
        ADD COLUMN IF NOT EXISTS short_description varchar(500),
        ADD COLUMN IF NOT EXISTS description text,
        ADD COLUMN IF NOT EXISTS culture_description text,
        ADD COLUMN IF NOT EXISTS benefits text[] NOT NULL DEFAULT '{}';

      UPDATE public.companies
         SET slug = 'company-' || left(id::text, 8)
       WHERE slug IS NULL;
      ALTER TABLE public.companies ALTER COLUMN slug SET NOT NULL;
      ALTER TABLE public.companies ALTER COLUMN slug SET DEFAULT gen_random_uuid()::text;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_slug ON public.companies (slug);

      ALTER TABLE public.jobs
        ADD COLUMN IF NOT EXISTS slug varchar(320),
        ADD COLUMN IF NOT EXISTS current_published_version_id uuid,
        ADD COLUMN IF NOT EXISTS application_mode varchar(16),
        ADD COLUMN IF NOT EXISTS work_mode varchar(16),
        ADD COLUMN IF NOT EXISTS primary_city_code varchar(64),
        ADD COLUMN IF NOT EXISTS location_city_codes text[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS salary_period varchar(16),
        ADD COLUMN IF NOT EXISTS salary_visible boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS salary_negotiable boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS openings_count integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS min_years_experience numeric(4,1),
        ADD COLUMN IF NOT EXISTS max_years_experience numeric(4,1),
        ADD COLUMN IF NOT EXISTS closed_at timestamptz,
        ADD COLUMN IF NOT EXISTS removed_at timestamptz,
        ADD COLUMN IF NOT EXISTS removed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS removal_reason text;

      UPDATE public.jobs
         SET slug = 'job-' || left(id::text, 8),
             application_mode = CASE WHEN source_type = 'employer' THEN 'NATIVE' ELSE 'EXTERNAL' END
       WHERE slug IS NULL OR application_mode IS NULL;
      ALTER TABLE public.jobs ALTER COLUMN slug SET NOT NULL;
      ALTER TABLE public.jobs ALTER COLUMN slug SET DEFAULT gen_random_uuid()::text;
      ALTER TABLE public.jobs ALTER COLUMN application_mode SET NOT NULL;
      ALTER TABLE public.jobs ALTER COLUMN application_mode SET DEFAULT 'EXTERNAL';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_slug ON public.jobs (slug);
      CREATE INDEX IF NOT EXISTS idx_jobs_application_mode ON public.jobs (application_mode);
      CREATE INDEX IF NOT EXISTS idx_jobs_work_mode ON public.jobs (work_mode);
      CREATE INDEX IF NOT EXISTS idx_jobs_primary_city ON public.jobs (primary_city_code);
      CREATE INDEX IF NOT EXISTS idx_jobs_location_cities_gin ON public.jobs USING gin (location_city_codes);

      ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_status;
      ALTER TABLE public.jobs ADD CONSTRAINT chk_jobs_status
        CHECK (status IN ('active', 'expired', 'draft', 'closed', 'removed'));
      ALTER TABLE public.jobs ADD CONSTRAINT chk_jobs_application_mode
        CHECK (application_mode IN ('NATIVE', 'EXTERNAL'));
      ALTER TABLE public.jobs ADD CONSTRAINT chk_jobs_work_mode
        CHECK (work_mode IS NULL OR work_mode IN ('ONSITE', 'HYBRID', 'REMOTE'));
      ALTER TABLE public.jobs ADD CONSTRAINT chk_jobs_salary_period
        CHECK (salary_period IS NULL OR salary_period IN ('MONTH', 'YEAR'));
      ALTER TABLE public.jobs ADD CONSTRAINT chk_jobs_openings_count
        CHECK (openings_count > 0);
      ALTER TABLE public.jobs ADD CONSTRAINT chk_jobs_experience_years
        CHECK (
          (min_years_experience IS NULL OR min_years_experience >= 0) AND
          (max_years_experience IS NULL OR max_years_experience >= 0) AND
          (min_years_experience IS NULL OR max_years_experience IS NULL OR min_years_experience <= max_years_experience)
        );
    `);

    await queryRunner.query(`
      CREATE TABLE public.business_profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
        status varchar(24) NOT NULL DEFAULT 'DRAFT',
        contact_name varchar(255),
        contact_phone varchar(32),
        work_email varchar(320),
        work_email_normalized varchar(320),
        work_email_domain varchar(255),
        work_email_verified_at timestamptz,
        submitted_at timestamptz,
        reviewed_at timestamptz,
        reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        rejection_reason text,
        suspension_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT uq_business_profiles_user UNIQUE (user_id),
        CONSTRAINT uq_business_profiles_company UNIQUE (company_id),
        CONSTRAINT uq_business_profiles_work_email UNIQUE (work_email_normalized),
        CONSTRAINT chk_business_profiles_status CHECK (status IN ('DRAFT','PENDING_REVIEW','VERIFIED','REJECTED','SUSPENDED'))
      );
      CREATE INDEX idx_business_profiles_status ON public.business_profiles (status);
    `);

    await queryRunner.query(`
      CREATE TABLE public.job_post_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
        version_no integer NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'DRAFT',
        revision integer NOT NULL DEFAULT 1,
        created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        title varchar(255) NOT NULL,
        role_code varchar(64),
        employment_type varchar(32),
        experience_level varchar(32),
        min_years_experience numeric(4,1),
        max_years_experience numeric(4,1),
        work_mode varchar(16),
        openings_count integer NOT NULL DEFAULT 1,
        salary_min numeric(12,2),
        salary_max numeric(12,2),
        currency varchar(8) NOT NULL DEFAULT 'VND',
        salary_period varchar(16),
        salary_visible boolean NOT NULL DEFAULT true,
        salary_negotiable boolean NOT NULL DEFAULT false,
        education_level varchar(32),
        language_code varchar(16),
        application_deadline timestamptz,
        summary text,
        responsibilities text[] NOT NULL DEFAULT '{}',
        requirements text[] NOT NULL DEFAULT '{}',
        nice_to_have text[] NOT NULL DEFAULT '{}',
        benefits text[] NOT NULL DEFAULT '{}',
        interview_process text[] NOT NULL DEFAULT '{}',
        working_time text,
        locations jsonb NOT NULL DEFAULT '[]'::jsonb,
        skills jsonb NOT NULL DEFAULT '[]'::jsonb,
        skills_confirmed_at timestamptz,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT uq_job_post_versions_number UNIQUE (job_id, version_no),
        CONSTRAINT chk_job_post_versions_status CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED')),
        CONSTRAINT chk_job_post_versions_revision CHECK (revision > 0),
        CONSTRAINT chk_job_post_versions_openings CHECK (openings_count > 0),
        CONSTRAINT chk_job_post_versions_locations CHECK (jsonb_typeof(locations) = 'array'),
        CONSTRAINT chk_job_post_versions_skills CHECK (jsonb_typeof(skills) = 'array')
      );
      CREATE UNIQUE INDEX uq_job_post_versions_one_draft
        ON public.job_post_versions (job_id) WHERE status = 'DRAFT';
      CREATE INDEX idx_job_post_versions_job_status ON public.job_post_versions (job_id, status);

      CREATE OR REPLACE FUNCTION public.protect_published_job_version()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.status IN ('PUBLISHED', 'SUPERSEDED') THEN
          IF OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED'
             AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'Published job versions are immutable'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_job_post_versions_immutable
        BEFORE UPDATE ON public.job_post_versions
        FOR EACH ROW EXECUTE FUNCTION public.protect_published_job_version();

      ALTER TABLE public.jobs ADD CONSTRAINT fk_jobs_current_published_version
        FOREIGN KEY (current_published_version_id) REFERENCES public.job_post_versions(id) ON DELETE SET NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE public.saved_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_saved_jobs_user_job UNIQUE (user_id, job_id)
      );
      CREATE INDEX idx_saved_jobs_user_created ON public.saved_jobs (user_id, created_at DESC);
    `);

    await queryRunner.query(`
      CREATE TABLE public.job_applications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
        job_version_id uuid NOT NULL REFERENCES public.job_post_versions(id) ON DELETE RESTRICT,
        candidate_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
        source_cv_id uuid REFERENCES public.cvs(id) ON DELETE SET NULL,
        status varchar(24) NOT NULL DEFAULT 'SUBMITTED',
        cover_note text,
        candidate_name varchar(255) NOT NULL,
        candidate_email varchar(320) NOT NULL,
        candidate_phone varchar(32),
        consent_version varchar(64) NOT NULL,
        consent_accepted_at timestamptz NOT NULL,
        cv_storage_object_key text,
        cv_original_file_name varchar(512),
        cv_content_type varchar(128),
        cv_file_size integer,
        cv_checksum_sha256 varchar(64),
        cv_kind varchar(16),
        cv_skills_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
        match_status varchar(16) NOT NULL DEFAULT 'PENDING',
        match_score numeric(5,2),
        match_scoring_version varchar(64),
        match_result jsonb,
        match_computed_at timestamptz,
        match_error_code varchar(64),
        first_viewed_at timestamptz,
        submitted_at timestamptz NOT NULL DEFAULT now(),
        withdrawn_at timestamptz,
        terminal_at timestamptz,
        pii_purge_after timestamptz,
        pii_purged_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT uq_job_applications_candidate UNIQUE (job_id, candidate_user_id),
        CONSTRAINT chk_job_applications_status CHECK (status IN ('SUBMITTED','IN_REVIEW','SHORTLISTED','REJECTED','WITHDRAWN')),
        CONSTRAINT chk_job_applications_match_status CHECK (match_status IN ('PENDING','READY','FAILED')),
        CONSTRAINT chk_job_applications_cv_skills CHECK (jsonb_typeof(cv_skills_snapshot) = 'array')
      );
      CREATE INDEX idx_job_applications_job_status_submitted
        ON public.job_applications (job_id, status, submitted_at DESC);
      CREATE INDEX idx_job_applications_candidate_submitted
        ON public.job_applications (candidate_user_id, submitted_at DESC);
      CREATE INDEX idx_job_applications_pii_purge
        ON public.job_applications (pii_purge_after) WHERE pii_purged_at IS NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE public.job_application_status_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id uuid NOT NULL REFERENCES public.job_applications(id) ON DELETE CASCADE,
        from_status varchar(24),
        to_status varchar(24) NOT NULL,
        actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        internal_note text,
        notification_type varchar(40) NOT NULL DEFAULT 'NONE',
        notification_status varchar(24) NOT NULL DEFAULT 'NOT_REQUIRED',
        notification_attempt_count integer NOT NULL DEFAULT 0,
        notification_next_attempt_at timestamptz,
        notification_sent_at timestamptz,
        notification_error_code varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_application_event_notification_type CHECK (notification_type IN ('NONE','NEW_APPLICATION','APPLICATION_STATUS_CHANGED')),
        CONSTRAINT chk_application_event_notification_status CHECK (notification_status IN ('NOT_REQUIRED','PENDING','SENT','FAILED'))
      );
      CREATE INDEX idx_application_events_application_created
        ON public.job_application_status_events (application_id, created_at);
      CREATE INDEX idx_application_events_notification_retry
        ON public.job_application_status_events (notification_status, notification_next_attempt_at);
    `);

    await queryRunner.query(`
      CREATE TABLE public.job_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
        reporter_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        reason_code varchar(24) NOT NULL,
        details text,
        status varchar(16) NOT NULL DEFAULT 'OPEN',
        resolved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        resolution_note text,
        resolved_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT uq_job_reports_reporter UNIQUE (job_id, reporter_user_id),
        CONSTRAINT chk_job_reports_reason CHECK (reason_code IN ('SCAM','MISLEADING','DISCRIMINATION','EXPIRED','OTHER')),
        CONSTRAINT chk_job_reports_status CHECK (status IN ('OPEN','DISMISSED','ACTIONED'))
      );
      CREATE INDEX idx_job_reports_status_created ON public.job_reports (status, created_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS fk_jobs_current_published_version;`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_job_post_versions_immutable ON public.job_post_versions;`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.protect_published_job_version();`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.job_reports;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.job_application_status_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.job_applications;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.saved_jobs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.job_post_versions;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.business_profiles;`);

    await queryRunner.query(`
      ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_experience_years;
      ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_openings_count;
      ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_salary_period;
      ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_work_mode;
      ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_application_mode;
      ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_status;
      UPDATE public.jobs SET status = 'expired' WHERE status = 'closed';
      ALTER TABLE public.jobs ADD CONSTRAINT chk_jobs_status
        CHECK (status IN ('active', 'expired', 'draft', 'removed'));
      DROP INDEX IF EXISTS public.idx_jobs_location_cities_gin;
      DROP INDEX IF EXISTS public.idx_jobs_primary_city;
      DROP INDEX IF EXISTS public.idx_jobs_work_mode;
      DROP INDEX IF EXISTS public.idx_jobs_application_mode;
      DROP INDEX IF EXISTS public.uq_jobs_slug;
      ALTER TABLE public.jobs
        DROP COLUMN IF EXISTS removal_reason,
        DROP COLUMN IF EXISTS removed_by_user_id,
        DROP COLUMN IF EXISTS removed_at,
        DROP COLUMN IF EXISTS closed_at,
        DROP COLUMN IF EXISTS max_years_experience,
        DROP COLUMN IF EXISTS min_years_experience,
        DROP COLUMN IF EXISTS openings_count,
        DROP COLUMN IF EXISTS salary_negotiable,
        DROP COLUMN IF EXISTS salary_visible,
        DROP COLUMN IF EXISTS salary_period,
        DROP COLUMN IF EXISTS location_city_codes,
        DROP COLUMN IF EXISTS primary_city_code,
        DROP COLUMN IF EXISTS work_mode,
        DROP COLUMN IF EXISTS application_mode,
        DROP COLUMN IF EXISTS current_published_version_id,
        DROP COLUMN IF EXISTS slug;

      DROP INDEX IF EXISTS public.uq_companies_slug;
      ALTER TABLE public.companies
        DROP COLUMN IF EXISTS benefits,
        DROP COLUMN IF EXISTS culture_description,
        DROP COLUMN IF EXISTS description,
        DROP COLUMN IF EXISTS short_description,
        DROP COLUMN IF EXISTS headquarters_address,
        DROP COLUMN IF EXISTS headquarters_city_code,
        DROP COLUMN IF EXISTS country_code,
        DROP COLUMN IF EXISTS founded_year,
        DROP COLUMN IF EXISTS company_size,
        DROP COLUMN IF EXISTS company_type,
        DROP COLUMN IF EXISTS industry_code,
        DROP COLUMN IF EXISTS linkedin_url,
        DROP COLUMN IF EXISTS cover_object_key,
        DROP COLUMN IF EXISTS logo_object_key,
        DROP COLUMN IF EXISTS slug;

      ALTER TABLE public.verifications DROP COLUMN IF EXISTS target_value_hash;
    `);
  }
}
