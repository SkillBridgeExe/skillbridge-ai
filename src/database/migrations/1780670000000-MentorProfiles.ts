import { MigrationInterface, QueryRunner } from 'typeorm';

export class MentorProfiles1780670000000 implements MigrationInterface {
  name = 'MentorProfiles1780670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.mentor_profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
        slug varchar NOT NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'DRAFT',
        headline varchar,
        company varchar,
        short_bio varchar,
        bio text,
        domain_tags text[] NOT NULL DEFAULT '{}',
        session_price_vnd integer NOT NULL DEFAULT 50000,
        session_duration_minutes integer NOT NULL DEFAULT 60,
        currency varchar NOT NULL DEFAULT 'VND',
        is_accepting_bookings boolean NOT NULL DEFAULT true,
        rating_average double precision,
        review_count integer NOT NULL DEFAULT 0,
        completed_sessions integer NOT NULL DEFAULT 0,
        submitted_at timestamptz,
        approved_at timestamptz,
        approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
        rejection_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_mentor_profiles_status CHECK (
          status IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED')
        ),
        CONSTRAINT chk_mentor_profiles_price CHECK (
          session_price_vnd BETWEEN 50000 AND 10000000
        ),
        CONSTRAINT chk_mentor_profiles_duration CHECK (
          session_duration_minutes IN (30, 45, 60, 90, 120)
        ),
        CONSTRAINT chk_mentor_profiles_rating CHECK (
          rating_average IS NULL OR (rating_average >= 0 AND rating_average <= 5)
        ),
        CONSTRAINT chk_mentor_profiles_counts CHECK (
          review_count >= 0 AND completed_sessions >= 0
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_profiles_status ON public.mentor_profiles (status);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_profiles_slug ON public.mentor_profiles (slug);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_profiles_domain_tags ON public.mentor_profiles USING GIN (domain_tags);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_profiles_price ON public.mentor_profiles (session_price_vnd);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_profiles_rating ON public.mentor_profiles (rating_average);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.mentor_profile_skills (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mentor_profile_id uuid NOT NULL REFERENCES public.mentor_profiles(id) ON DELETE CASCADE,
        skill_id uuid NOT NULL REFERENCES public.skills(id) ON DELETE RESTRICT,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_mentor_profile_skills_profile_skill UNIQUE (mentor_profile_id, skill_id)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_profile_skills_profile ON public.mentor_profile_skills (mentor_profile_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_profile_skills_skill ON public.mentor_profile_skills (skill_id);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.mentor_profile_skills;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.mentor_profiles;`);
  }
}
