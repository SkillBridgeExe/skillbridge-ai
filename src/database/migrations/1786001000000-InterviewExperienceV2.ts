import { MigrationInterface, QueryRunner } from 'typeorm';

export class InterviewExperienceV21786001000000 implements MigrationInterface {
  name = 'InterviewExperienceV21786001000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
        ADD COLUMN IF NOT EXISTS experience_mode varchar NOT NULL DEFAULT 'MOCK';

      ALTER TABLE public.interview_sessions
        DROP CONSTRAINT IF EXISTS chk_interview_sessions_mode;
      UPDATE public.interview_sessions SET mode = 'VOICE' WHERE mode = 'HYBRID';
      ALTER TABLE public.interview_sessions
        ADD CONSTRAINT chk_interview_sessions_mode CHECK (mode IN ('TEXT', 'VOICE'));

      ALTER TABLE public.interview_turns
        ADD COLUMN IF NOT EXISTS client_turn_id varchar NULL,
        ADD COLUMN IF NOT EXISTS question_thread_id uuid NULL,
        ADD COLUMN IF NOT EXISTS candidate_intent varchar NULL,
        ADD COLUMN IF NOT EXISTS assistance_level varchar NULL,
        ADD COLUMN IF NOT EXISTS score_cap integer NULL,
        ADD COLUMN IF NOT EXISTS skip_reason varchar NULL,
        ADD COLUMN IF NOT EXISTS assistant_response_id varchar NULL,
        ADD COLUMN IF NOT EXISTS first_audio_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS assistant_interrupted boolean NOT NULL DEFAULT false;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_turns_session_client_turn_unique
        ON public.interview_turns (session_id, client_turn_id)
        WHERE client_turn_id IS NOT NULL;
`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS public.idx_interview_turns_session_client_turn_unique;

      ALTER TABLE public.interview_turns
        DROP COLUMN IF EXISTS assistant_interrupted,
        DROP COLUMN IF EXISTS first_audio_at,
        DROP COLUMN IF EXISTS assistant_response_id,
        DROP COLUMN IF EXISTS skip_reason,
        DROP COLUMN IF EXISTS score_cap,
        DROP COLUMN IF EXISTS assistance_level,
        DROP COLUMN IF EXISTS candidate_intent,
        DROP COLUMN IF EXISTS question_thread_id,
        DROP COLUMN IF EXISTS client_turn_id;

      ALTER TABLE public.interview_sessions
        DROP CONSTRAINT IF EXISTS chk_interview_sessions_mode;
      ALTER TABLE public.interview_sessions
        ADD CONSTRAINT chk_interview_sessions_mode CHECK (mode IN ('TEXT', 'VOICE', 'HYBRID'));

      ALTER TABLE public.interview_sessions
        DROP COLUMN IF EXISTS experience_mode;
    `);
  }
}
