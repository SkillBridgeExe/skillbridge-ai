import { MigrationInterface, QueryRunner } from 'typeorm';

export class JobRecommendationSnapshots1781260000000 implements MigrationInterface {
  name = 'JobRecommendationSnapshots1781260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.job_recommendation_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        cv_id uuid NOT NULL REFERENCES public.cvs(id) ON DELETE CASCADE,
        input_fingerprint varchar(64) NOT NULL,
        ranking_version varchar(32) NOT NULL,
        claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
        payload jsonb,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_job_recommendation_snapshot
          UNIQUE (user_id, cv_id, input_fingerprint, ranking_version)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_job_recommendation_snapshot_lookup
        ON public.job_recommendation_snapshots
        (user_id, cv_id, input_fingerprint, ranking_version, expires_at);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_job_recommendation_snapshot_expiry
        ON public.job_recommendation_snapshots (expires_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_job_recommendation_snapshot_expiry;`);
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_job_recommendation_snapshot_lookup;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.job_recommendation_snapshots;`);
  }
}
