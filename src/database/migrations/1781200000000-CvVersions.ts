import { MigrationInterface, QueryRunner } from 'typeorm';

export class CvVersions1781200000000 implements MigrationInterface {
  name = 'CvVersions1781200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cv_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "cv_id" uuid NOT NULL,
        "snapshot" jsonb NOT NULL,
        "title" character varying,
        "label" character varying,
        "origin" character varying NOT NULL DEFAULT 'MANUAL',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cv_versions_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_cv_versions_cv_id" FOREIGN KEY ("cv_id") REFERENCES "cvs"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cv_versions_cv_created" ON "cv_versions" ("cv_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cv_versions" DROP CONSTRAINT IF EXISTS "FK_cv_versions_cv_id"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_cv_versions_cv_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cv_versions"`);
  }
}
