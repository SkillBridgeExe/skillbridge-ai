import { MigrationInterface, QueryRunner } from 'typeorm';

export class R1CvDiagnosisCompletion1780410000000 implements MigrationInterface {
  name = 'R1CvDiagnosisCompletion1780410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "cvs"
        ADD COLUMN IF NOT EXISTS "target_role" character varying
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cvs_target_role" ON "cvs" ("target_role")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cv_consent_audits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "cv_id" uuid NOT NULL,
        "consent_version" character varying NOT NULL,
        "consent_source" character varying NOT NULL,
        "accepted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cv_consent_audits_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cv_consent_audits_user_id" ON "cv_consent_audits" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cv_consent_audits_cv_id" ON "cv_consent_audits" ("cv_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cv_consent_audits_user_cv" ON "cv_consent_audits" ("user_id", "cv_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cv_consent_audits_created_at" ON "cv_consent_audits" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_consent_audits_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_consent_audits_user_cv"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_consent_audits_cv_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_consent_audits_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cv_consent_audits"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cvs_target_role"`);
    await queryRunner.query(`ALTER TABLE "cvs" DROP COLUMN IF EXISTS "target_role"`);
  }
}
