import { MigrationInterface, QueryRunner } from 'typeorm';

export class CvContentHash1780640000000 implements MigrationInterface {
  name = 'CvContentHash1780640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.cvs
      ADD COLUMN IF NOT EXISTS content_hash varchar(64);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cvs_user_content_hash
      ON public.cvs (user_id, content_hash)
      WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_cvs_user_content_hash;`);
    await queryRunner.query(`
      ALTER TABLE public.cvs
      DROP COLUMN IF EXISTS content_hash;
    `);
  }
}
