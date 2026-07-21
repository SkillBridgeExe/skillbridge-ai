import { MigrationInterface, QueryRunner } from 'typeorm';

export class LearningRoadmapsV21781250000000 implements MigrationInterface {
  name = 'LearningRoadmapsV21781250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE learning_roadmaps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        intent varchar(32) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'DRAFT',
        cv_match_id uuid NULL REFERENCES cv_matches(id) ON DELETE RESTRICT,
        target_role varchar(100) NULL,
        target_level varchar(24) NULL,
        active_version_id uuid NULL,
        revision integer NOT NULL DEFAULT 0,
        draft_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_learning_roadmaps_intent CHECK (intent IN ('JD_APPLICATION', 'CAREER_ROLE')),
        CONSTRAINT ck_learning_roadmaps_status CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
        CONSTRAINT ck_learning_roadmaps_context CHECK (
          (intent = 'JD_APPLICATION' AND cv_match_id IS NOT NULL AND target_role IS NULL) OR
          (intent = 'CAREER_ROLE' AND cv_match_id IS NULL AND target_role IS NOT NULL)
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_learning_roadmaps_user_status ON learning_roadmaps(user_id, status);`,
    );

    await queryRunner.query(`
      CREATE TABLE learning_roadmap_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        roadmap_id uuid NOT NULL REFERENCES learning_roadmaps(id) ON DELETE CASCADE,
        version_no integer NOT NULL CHECK (version_no > 0),
        input_snapshot jsonb NOT NULL,
        source_gap_snapshot jsonb NOT NULL,
        resource_catalog_version varchar(64) NOT NULL,
        content_version varchar(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (roadmap_id, version_no)
      );
    `);
    await queryRunner.query(`
      ALTER TABLE learning_roadmaps
      ADD CONSTRAINT fk_learning_roadmaps_active_version
      FOREIGN KEY (active_version_id) REFERENCES learning_roadmap_versions(id) ON DELETE SET NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE learning_schedule_profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name varchar(80) NOT NULL DEFAULT 'Default',
        timezone varchar(80) NOT NULL,
        session_minutes integer NOT NULL CHECK (session_minutes IN (30, 45, 60, 90)),
        is_default boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_learning_schedule_default ON learning_schedule_profiles(user_id) WHERE is_default = true;`,
    );

    await queryRunner.query(`
      CREATE TABLE learning_availability_slots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id uuid NOT NULL REFERENCES learning_schedule_profiles(id) ON DELETE CASCADE,
        iso_weekday smallint NOT NULL,
        start_time time NOT NULL,
        duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 30 AND 720),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (iso_weekday BETWEEN 1 AND 7),
        UNIQUE (profile_id, iso_weekday, start_time)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE learning_modules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        version_id uuid NOT NULL REFERENCES learning_roadmap_versions(id) ON DELETE CASCADE,
        skill_id uuid NULL REFERENCES skills(id) ON DELETE SET NULL,
        skill_canonical varchar(160) NOT NULL,
        display_name varchar(200) NOT NULL,
        rank integer NOT NULL CHECK (rank > 0),
        system_priority numeric(8,3) NOT NULL,
        user_priority integer NULL,
        rationale text NOT NULL,
        prerequisite_canonicals jsonb NOT NULL DEFAULT '[]'::jsonb,
        estimated_minutes integer NOT NULL CHECK (estimated_minutes > 0),
        feasibility varchar(16) NOT NULL CHECK (feasibility IN ('FEASIBLE', 'DEFERRED')),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (version_id, skill_canonical)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE learning_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        module_id uuid NOT NULL REFERENCES learning_modules(id) ON DELETE CASCADE,
        sequence integer NOT NULL CHECK (sequence > 0),
        title varchar(240) NOT NULL,
        scheduled_start_at timestamptz NOT NULL,
        duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 720),
        required_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (module_id, sequence)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_learning_sessions_start ON learning_sessions(scheduled_start_at);`,
    );

    await queryRunner.query(`
      CREATE TABLE learning_quiz_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        question_id varchar(180) NOT NULL,
        selected_option_index integer NOT NULL CHECK (selected_option_index >= 0),
        is_correct boolean NOT NULL,
        attempt_no integer NOT NULL CHECK (attempt_no > 0),
        answered_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (session_id, user_id, question_id, attempt_no)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE learning_evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id varchar(180) NOT NULL,
        content text NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'ACCEPTED', 'REJECTED')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (session_id, user_id, task_id)
      );
    `);

    await queryRunner.query(`
      ALTER TABLE learning_session_progress
      ADD COLUMN learning_session_id uuid NULL REFERENCES learning_sessions(id) ON DELETE CASCADE;
    `);
    await queryRunner.query(`
      ALTER TABLE learning_session_progress
      ADD COLUMN revision integer NOT NULL DEFAULT 0;
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_learning_progress_v2_session ON learning_session_progress(user_id, learning_session_id) WHERE learning_session_id IS NOT NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_learning_progress_v2_session;`);
    await queryRunner.query(`ALTER TABLE learning_session_progress DROP COLUMN revision;`);
    await queryRunner.query(
      `ALTER TABLE learning_session_progress DROP COLUMN learning_session_id;`,
    );
    await queryRunner.query(`DROP TABLE learning_evidence;`);
    await queryRunner.query(`DROP TABLE learning_quiz_attempts;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_learning_sessions_start;`);
    await queryRunner.query(`DROP TABLE learning_sessions;`);
    await queryRunner.query(`DROP TABLE learning_modules;`);
    await queryRunner.query(`DROP TABLE learning_availability_slots;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_learning_schedule_default;`);
    await queryRunner.query(`DROP TABLE learning_schedule_profiles;`);
    await queryRunner.query(
      `ALTER TABLE learning_roadmaps DROP CONSTRAINT fk_learning_roadmaps_active_version;`,
    );
    await queryRunner.query(`DROP TABLE learning_roadmap_versions;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_learning_roadmaps_user_status;`);
    await queryRunner.query(`DROP TABLE learning_roadmaps;`);
  }
}
