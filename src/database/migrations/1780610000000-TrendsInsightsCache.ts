import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Trends-Insight cache — one "AI nhận định" payload per (cv_key, role, period).
 * cv_key = cv_id ?? 'none' (role-level). period = snapshot date → nightly cron naturally
 * invalidates. Additive + reversible; no FK on cv_key (carries the 'none' sentinel).
 */
export class TrendsInsightsCache1780610000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.trends_insights (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cv_key varchar(64) NOT NULL,
        role_code varchar(64) NOT NULL,
        period date NOT NULL,
        payload jsonb NOT NULL,
        model varchar(64),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_trends_insights
         ON public.trends_insights (cv_key, role_code, period)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.trends_insights`);
  }
}
