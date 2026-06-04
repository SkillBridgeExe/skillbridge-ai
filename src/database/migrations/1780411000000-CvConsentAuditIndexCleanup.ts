import { MigrationInterface, QueryRunner } from 'typeorm';

export class CvConsentAuditIndexCleanup1780411000000 implements MigrationInterface {
  name = 'CvConsentAuditIndexCleanup1780411000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_consent_audits_user_id"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cv_consent_audits_user_id" ON "cv_consent_audits" ("user_id")`,
    );
  }
}
