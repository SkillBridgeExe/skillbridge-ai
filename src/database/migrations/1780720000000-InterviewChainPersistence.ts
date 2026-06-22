import { MigrationInterface, QueryRunner } from 'typeorm';

export class InterviewChainPersistence1780720000000 implements MigrationInterface {
  name = 'InterviewChainPersistence1780720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
        ADD COLUMN IF NOT EXISTS agenda jsonb,
        ADD COLUMN IF NOT EXISTS interview_state jsonb,
        ADD COLUMN IF NOT EXISTS final_score jsonb,
        ADD COLUMN IF NOT EXISTS gap_items jsonb,
        ADD COLUMN IF NOT EXISTS dev_plan jsonb,
        ADD COLUMN IF NOT EXISTS coaching jsonb;
    `);

    await queryRunner.query(`
      ALTER TABLE public.interview_turns
        ADD COLUMN IF NOT EXISTS topic_phase varchar,
        ADD COLUMN IF NOT EXISTS depth_signal varchar,
        ADD COLUMN IF NOT EXISTS signals jsonb,
        ADD COLUMN IF NOT EXISTS insight jsonb,
        ADD COLUMN IF NOT EXISTS current_thread text,
        ADD COLUMN IF NOT EXISTS skill_canonical varchar;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.interview_turns
        DROP COLUMN IF EXISTS skill_canonical,
        DROP COLUMN IF EXISTS current_thread,
        DROP COLUMN IF EXISTS insight,
        DROP COLUMN IF EXISTS signals,
        DROP COLUMN IF EXISTS depth_signal,
        DROP COLUMN IF EXISTS topic_phase;
    `);

    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
        DROP COLUMN IF EXISTS coaching,
        DROP COLUMN IF EXISTS dev_plan,
        DROP COLUMN IF EXISTS gap_items,
        DROP COLUMN IF EXISTS final_score,
        DROP COLUMN IF EXISTS interview_state,
        DROP COLUMN IF EXISTS agenda;
    `);
  }
}
