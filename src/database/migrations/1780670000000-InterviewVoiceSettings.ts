import { MigrationInterface, QueryRunner } from 'typeorm';

export class InterviewVoiceSettings1780670000000 implements MigrationInterface {
  name = 'InterviewVoiceSettings1780670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
      ADD COLUMN IF NOT EXISTS voice varchar NOT NULL DEFAULT 'marin',
      ADD COLUMN IF NOT EXISTS speech_speed numeric(4,2) NOT NULL DEFAULT 1.15;
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
      DROP CONSTRAINT IF EXISTS chk_interview_sessions_voice;
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
      ADD CONSTRAINT chk_interview_sessions_voice CHECK (
        voice IN ('alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar')
      );
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
      DROP CONSTRAINT IF EXISTS chk_interview_sessions_speech_speed;
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
      ADD CONSTRAINT chk_interview_sessions_speech_speed CHECK (
        speech_speed >= 0.75 AND speech_speed <= 1.50
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
      DROP CONSTRAINT IF EXISTS chk_interview_sessions_speech_speed;
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
      DROP CONSTRAINT IF EXISTS chk_interview_sessions_voice;
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_sessions
      DROP COLUMN IF EXISTS speech_speed,
      DROP COLUMN IF EXISTS voice;
    `);
  }
}
