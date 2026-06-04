import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserProfilesAndSkills1780490000000 implements MigrationInterface {
  name = 'UserProfilesAndSkills1780490000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "university" character varying,
        "major" character varying,
        "experience_years" integer,
        "target_job" character varying,
        "career_goal" text,
        "github_url" text,
        "linkedin_url" text,
        "portfolio_url" text,
        "document_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        CONSTRAINT "PK_user_profiles_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_profiles_user_id" ON "user_profiles" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_profiles_target_job" ON "user_profiles" ("target_job")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_profiles_document_id" ON "user_profiles" ("document_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_skills" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "skill_id" uuid NOT NULL,
        "level" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        CONSTRAINT "PK_user_skills_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_skills_user_id" ON "user_skills" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_skills_skill_id" ON "user_skills" ("skill_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_skills_user_skill" ON "user_skills" ("user_id", "skill_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_user_skills_user_skill"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_user_skills_skill_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_user_skills_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_skills"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_user_profiles_document_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_user_profiles_target_job"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_user_profiles_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_profiles"`);
  }
}
