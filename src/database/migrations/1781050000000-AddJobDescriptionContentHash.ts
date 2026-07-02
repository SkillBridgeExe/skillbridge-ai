import { createHash } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobDescriptionContentHash1781050000000 implements MigrationInterface {
  name = 'AddJobDescriptionContentHash1781050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "job_descriptions" ADD COLUMN "content_hash" varchar(64)`);
    await queryRunner.query(
      `CREATE INDEX "IDX_job_descriptions_content_hash" ON "job_descriptions" ("content_hash")`,
    );
    // Backfill in batches; a row that fails to hash stays NULL (never becomes a prior — safe).
    const rows: Array<{ id: string; raw_text: string }> = await queryRunner.query(
      `SELECT id, raw_text FROM "job_descriptions" WHERE raw_text IS NOT NULL`,
    );
    for (const row of rows) {
      const normalized = row.raw_text.trim().replace(/\s+/g, ' ').toLowerCase();
      const hash = createHash('sha256').update(normalized, 'utf8').digest('hex');
      await queryRunner.query(`UPDATE "job_descriptions" SET content_hash = $1 WHERE id = $2`, [
        hash,
        row.id,
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_job_descriptions_content_hash"`);
    await queryRunner.query(`ALTER TABLE "job_descriptions" DROP COLUMN "content_hash"`);
  }
}
