import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * R2 P0 platform persistence for user-provided JD matching.
 *
 * Distinct from the scraped jobs pool: user-provided JD text is stored so the owner can
 * reopen match history; scraped job descriptions still store metadata/skills only.
 */
export class CvMatchPersistence1780520000000 implements MigrationInterface {
  name = 'CvMatchPersistence1780520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.job_descriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        title varchar,
        raw_text text NOT NULL,
        parsed_json jsonb,
        source_type varchar,
        document_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_job_descriptions_source_type CHECK (
          source_type IS NULL OR source_type IN ('PASTED', 'UPLOADED', 'SAMPLE')
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_job_descriptions_user ON public.job_descriptions (user_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_job_descriptions_document ON public.job_descriptions (document_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_job_descriptions_source_type ON public.job_descriptions (source_type);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_job_descriptions_created ON public.job_descriptions (created_at);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.cv_matches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cv_id uuid NOT NULL REFERENCES public.cvs(id) ON DELETE CASCADE,
        target_type varchar NOT NULL,
        job_description_id uuid REFERENCES public.job_descriptions(id) ON DELETE SET NULL,
        ai_result_id uuid REFERENCES public.ai_results(id) ON DELETE SET NULL,
        overall_score numeric(5,2),
        semantic_score numeric(5,2),
        ats_score numeric(5,2),
        llm_score numeric(5,2),
        rule_engine_score numeric(5,2),
        strengths jsonb,
        weaknesses jsonb,
        suggestions jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_cv_matches_target_type CHECK (target_type IN ('JOB_DESCRIPTION'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cv_matches_cv ON public.cv_matches (cv_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cv_matches_target_type ON public.cv_matches (target_type);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cv_matches_jd ON public.cv_matches (job_description_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cv_matches_ai_result ON public.cv_matches (ai_result_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cv_matches_created ON public.cv_matches (created_at);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.cv_match_scores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        match_id uuid NOT NULL REFERENCES public.cv_matches(id) ON DELETE CASCADE,
        criteria_name varchar NOT NULL,
        score numeric(5,2),
        weight numeric(5,2),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cv_match_scores_match ON public.cv_match_scores (match_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cv_match_scores_criteria ON public.cv_match_scores (criteria_name);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.cv_match_scores;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.cv_matches;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.job_descriptions;`);
  }
}
