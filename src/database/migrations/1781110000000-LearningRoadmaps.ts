import { MigrationInterface, QueryRunner } from 'typeorm';

export class LearningRoadmaps1781110000000 implements MigrationInterface {
  name = 'LearningRoadmaps1781110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.learning_roadmaps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        active boolean NOT NULL DEFAULT true,
        source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
        composed_roadmap jsonb NOT NULL,
        schedule jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_learning_roadmaps_user_active
      ON public.learning_roadmaps (user_id, active)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS public.idx_learning_roadmaps_user_active');
    await queryRunner.query('DROP TABLE IF EXISTS public.learning_roadmaps');
  }
}
