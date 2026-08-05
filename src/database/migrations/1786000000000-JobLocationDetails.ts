import { MigrationInterface, QueryRunner } from 'typeorm';

export class JobLocationDetails1786000000000 implements MigrationInterface {
  name = 'JobLocationDetails1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.jobs
        ADD COLUMN IF NOT EXISTS locations jsonb NOT NULL DEFAULT '[]'::jsonb;

      ALTER TABLE public.jobs
        DROP CONSTRAINT IF EXISTS chk_jobs_locations;
      ALTER TABLE public.jobs
        ADD CONSTRAINT chk_jobs_locations CHECK (jsonb_typeof(locations) = 'array');

      CREATE INDEX IF NOT EXISTS idx_jobs_locations_gin
        ON public.jobs USING gin (locations);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS public.idx_jobs_locations_gin;
      ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_locations;
      ALTER TABLE public.jobs DROP COLUMN IF EXISTS locations;
    `);
  }
}
