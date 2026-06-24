import { MigrationInterface, QueryRunner } from 'typeorm';

export class LearningSessionProgress1780720000000 implements MigrationInterface {
  name = 'LearningSessionProgress1780720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.learning_session_progress (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        session_id varchar(160) NOT NULL,
        checked_checklist_items jsonb NOT NULL DEFAULT '{}'::jsonb,
        exercise_proofs jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT fk_learning_session_progress_user
          FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_session_progress_user_session
        ON public.learning_session_progress (user_id, session_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.learning_session_progress;`);
  }
}
