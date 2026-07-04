import { MigrationInterface, QueryRunner } from 'typeorm';

export class LearningQuizAttempts1780740000000 implements MigrationInterface {
  name = 'LearningQuizAttempts1780740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.learning_session_progress
        ADD COLUMN IF NOT EXISTS quiz_attempts jsonb NOT NULL DEFAULT '{}'::jsonb;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.learning_session_progress
        DROP COLUMN IF EXISTS quiz_attempts;
    `);
  }
}
