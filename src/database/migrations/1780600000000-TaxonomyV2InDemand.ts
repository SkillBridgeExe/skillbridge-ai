import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Taxonomy v2 Phase 1 — add `skills.in_demand` (deterministic demand flag).
 * Derived from the job pool (high-frequency skills) + O*NET Hot Technology on import.
 * Additive + backward-compatible (default false); reversible.
 */
export class TaxonomyV2InDemand1780600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.skills ADD COLUMN IF NOT EXISTS in_demand boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_skills_in_demand ON public.skills (in_demand) WHERE in_demand = true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_skills_in_demand`);
    await queryRunner.query(`ALTER TABLE public.skills DROP COLUMN IF EXISTS in_demand`);
  }
}
