import { MigrationInterface, QueryRunner } from 'typeorm';

export class InterviewPlatformPersistence1780650000000 implements MigrationInterface {
  name = 'InterviewPlatformPersistence1780650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.interview_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        cv_id uuid REFERENCES public.cvs(id) ON DELETE SET NULL,
        job_description_id uuid REFERENCES public.job_descriptions(id) ON DELETE SET NULL,
        cv_match_id uuid REFERENCES public.cv_matches(id) ON DELETE SET NULL,
        target_role varchar NOT NULL,
        language varchar NOT NULL DEFAULT 'vi',
        mode varchar NOT NULL,
        interview_type varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'IN_PROGRESS',
        realtime_provider varchar,
        realtime_model varchar,
        realtime_session_id varchar,
        final_ai_request_id uuid REFERENCES public.ai_requests(id) ON DELETE SET NULL,
        final_ai_result_id uuid REFERENCES public.ai_results(id) ON DELETE SET NULL,
        total_questions_planned integer,
        max_duration_seconds integer NOT NULL DEFAULT 600,
        expires_at timestamptz,
        overall_score numeric(5,2),
        semantic_score numeric(5,2),
        llm_score numeric(5,2),
        communication_score numeric(5,2),
        ai_feedback jsonb,
        context_snapshot jsonb,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        duration_seconds integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_interview_sessions_mode CHECK (mode IN ('TEXT', 'VOICE', 'HYBRID')),
        CONSTRAINT chk_interview_sessions_type CHECK (interview_type IN ('HR', 'TECHNICAL', 'MIXED')),
        CONSTRAINT chk_interview_sessions_status CHECK (
          status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED')
        ),
        CONSTRAINT chk_interview_sessions_duration CHECK (
          duration_seconds IS NULL OR duration_seconds >= 0
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_interview_sessions_user ON public.interview_sessions (user_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_interview_sessions_cv ON public.interview_sessions (cv_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_interview_sessions_jd ON public.interview_sessions (job_description_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_interview_sessions_match ON public.interview_sessions (cv_match_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_interview_sessions_status ON public.interview_sessions (status);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_interview_sessions_started ON public.interview_sessions (started_at);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.interview_turns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
        turn_order integer NOT NULL,
        phase varchar,
        modality varchar NOT NULL DEFAULT 'TEXT',
        ai_request_id uuid REFERENCES public.ai_requests(id) ON DELETE SET NULL,
        interviewer_message text,
        interviewer_question text NOT NULL,
        user_answer_text text,
        user_answer_transcript text,
        per_question_score numeric(5,2),
        strengths jsonb,
        improvements jsonb,
        asked_at timestamptz NOT NULL DEFAULT now(),
        answered_at timestamptz,
        duration_seconds integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT uq_interview_turns_session_order UNIQUE (session_id, turn_order),
        CONSTRAINT chk_interview_turns_modality CHECK (modality IN ('TEXT', 'AUDIO')),
        CONSTRAINT chk_interview_turns_duration CHECK (
          duration_seconds IS NULL OR duration_seconds >= 0
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_interview_turns_session ON public.interview_turns (session_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_interview_turns_ai_request ON public.interview_turns (ai_request_id);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.interview_turns;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.interview_sessions;`);
  }
}
