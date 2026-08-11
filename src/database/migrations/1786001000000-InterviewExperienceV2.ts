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
        ADD COLUMN IF NOT EXISTS directive_id uuid NULL,
        ADD COLUMN IF NOT EXISTS source_directive_id uuid NULL,
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_turns_directive_id
        ON public.interview_turns (directive_id)
        WHERE directive_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_turns_source_directive_id
        ON public.interview_turns (source_directive_id)
        WHERE source_directive_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS public.interview_realtime_directives (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
        turn_id uuid NULL REFERENCES public.interview_turns(id) ON DELETE SET NULL,
        client_turn_id varchar NOT NULL,
        transcript varchar NOT NULL,
        modality varchar NOT NULL,
        intent varchar NOT NULL,
        answer_signal varchar NOT NULL,
        action varchar NOT NULL,
        consumes_attempt boolean NOT NULL,
        topic_id varchar NULL,
        question_thread_id uuid NOT NULL,
        difficulty_step integer NOT NULL,
        assistance_level varchar NOT NULL,
        score_cap integer NULL,
        thread_score integer NULL,
        finished boolean NOT NULL,
        question_goal text NOT NULL,
        reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
        speech_ended_at timestamptz NULL,
        assistant_response_id varchar NULL,
        assistant_message text NULL,
        assistant_question text NULL,
        first_audio_at timestamptz NULL,
        assistant_interrupted boolean NOT NULL DEFAULT false,
        committed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_realtime_directives_session_client_unique
        ON public.interview_realtime_directives (session_id, client_turn_id);
      CREATE INDEX IF NOT EXISTS idx_interview_realtime_directives_session_id
        ON public.interview_realtime_directives (session_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS public.interview_realtime_directives;
      DROP INDEX IF EXISTS public.idx_interview_turns_source_directive_id;
      DROP INDEX IF EXISTS public.idx_interview_turns_directive_id;
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
        DROP COLUMN IF EXISTS source_directive_id,
        DROP COLUMN IF EXISTS directive_id,
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
