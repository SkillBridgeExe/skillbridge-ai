import { MigrationInterface, QueryRunner } from 'typeorm';

export class ImpactCalibrations1781070000000 implements MigrationInterface {
  name = 'ImpactCalibrations1781070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "impact_calibrations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid,
        "prior_match_id" uuid NOT NULL,
        "current_match_id" uuid NOT NULL,
        "jd_content_hash" character varying(64) NOT NULL,
        "canonical_name" character varying(120) NOT NULL,
        "action_type" character varying(32) NOT NULL,
        "predicted_score_min" numeric(5,2) NOT NULL,
        "predicted_score_max" numeric(5,2) NOT NULL,
        "predicted_severity_drop" numeric(6,3),
        "actual_score_delta" numeric(5,2),
        "actual_severity_delta" numeric(6,3),
        "status_transition" character varying(16) NOT NULL,
        "attempted" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_impact_calibrations_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_impact_calibrations_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "UQ_impact_calibrations_prior_current_canonical" UNIQUE ("prior_match_id", "current_match_id", "canonical_name")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_impact_calibrations_user_created" ON "impact_calibrations" ("user_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "impact_calibrations" DROP CONSTRAINT IF EXISTS "FK_impact_calibrations_user_id"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_impact_calibrations_user_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "impact_calibrations"`);
  }
}
