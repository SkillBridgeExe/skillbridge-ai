import { MigrationInterface, QueryRunner } from 'typeorm';

export class CvUploadR2Persistence1780330000000 implements MigrationInterface {
  name = 'CvUploadR2Persistence1780330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      ALTER TABLE "cvs"
        ADD COLUMN IF NOT EXISTS "parsed_json" jsonb,
        ADD COLUMN IF NOT EXISTS "cv_kind" character varying NOT NULL DEFAULT 'UPLOADED',
        ADD COLUMN IF NOT EXISTS "language" character varying,
        ADD COLUMN IF NOT EXISTS "is_ocr_only" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "skills" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "canonical_name" character varying NOT NULL,
        "display_name" character varying NOT NULL,
        "category" character varying,
        "source" character varying,
        "source_external_id" character varying,
        "aliases" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        CONSTRAINT "PK_skills_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_skills_canonical_name" ON "skills" ("canonical_name")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_skills_category" ON "skills" ("category")`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_skills_source" ON "skills" ("source")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cv_skills" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "cv_id" uuid NOT NULL,
        "skill_id" uuid NOT NULL,
        "confidence" numeric(5,2),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cv_skills_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cv_skills_cv_id" ON "cv_skills" ("cv_id")`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cv_skills_skill_id" ON "cv_skills" ("skill_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cv_skills_cv_skill" ON "cv_skills" ("cv_id", "skill_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid,
        "ai_job_id" uuid,
        "model_id" uuid,
        "prompt_template_id" uuid,
        "request_type" character varying NOT NULL,
        "request_payload" jsonb,
        "prompt_tokens" integer,
        "completion_tokens" integer,
        "total_tokens" integer,
        "estimated_cost" numeric(12,6),
        "latency_ms" integer,
        "status" character varying NOT NULL DEFAULT 'PENDING',
        "error_message" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_requests_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_requests_user_id" ON "ai_requests" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_requests_ai_job_id" ON "ai_requests" ("ai_job_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_requests_model_id" ON "ai_requests" ("model_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_requests_prompt_template_id" ON "ai_requests" ("prompt_template_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_requests_request_type" ON "ai_requests" ("request_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_requests_status" ON "ai_requests" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_requests_created_at" ON "ai_requests" ("created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_results" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ai_request_id" uuid NOT NULL,
        "user_id" uuid,
        "result_type" character varying,
        "raw_response" jsonb,
        "parsed_response" jsonb,
        "total_score" numeric(5,2),
        "confidence_score" numeric(5,2),
        "token_usage" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_results_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_results_ai_request_id" ON "ai_results" ("ai_request_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_results_user_id" ON "ai_results" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_results_result_type" ON "ai_results" ("result_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_results_created_at" ON "ai_results" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_results_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_results_result_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_results_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_results_ai_request_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_results"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_requests_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_requests_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_requests_request_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_requests_prompt_template_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_requests_model_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_requests_ai_job_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_requests_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_requests"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_skills_cv_skill"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_skills_skill_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_skills_cv_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cv_skills"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_skills_source"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_skills_category"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_skills_canonical_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "skills"`);
  }
}
