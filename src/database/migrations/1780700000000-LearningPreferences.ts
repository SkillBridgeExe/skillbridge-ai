import { MigrationInterface, QueryRunner } from 'typeorm';

export class LearningPreferences1780700000000 implements MigrationInterface {
  name = 'LearningPreferences1780700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.learning_preferences (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        language_pref varchar NOT NULL DEFAULT 'both',
        available_days int NOT NULL DEFAULT 30,
        hours_per_week int NOT NULL DEFAULT 8,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT uq_learning_preferences_user UNIQUE (user_id),
        CONSTRAINT chk_learning_preferences_language
          CHECK (language_pref IN ('vi', 'en', 'both')),
        CONSTRAINT chk_learning_preferences_available_days
          CHECK (available_days BETWEEN 1 AND 365),
        CONSTRAINT chk_learning_preferences_hours_per_week
          CHECK (hours_per_week BETWEEN 1 AND 80),
        CONSTRAINT fk_learning_preferences_user
          FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_learning_preferences_user_id ON public.learning_preferences (user_id);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.learning_preferences;`);
  }
}
