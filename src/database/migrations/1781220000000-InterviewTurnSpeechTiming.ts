import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3 Voice Quality: client-measured speech timing per answered turn — response delay
 * (mic-open → first speech) and STT transcript segment count (long-pause proxy). Both
 * nullable: text mode and legacy turns simply have none.
 */
export class InterviewTurnSpeechTiming1781220000000 implements MigrationInterface {
  name = 'InterviewTurnSpeechTiming1781220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "interview_turns" ADD COLUMN IF NOT EXISTS "response_delay_ms" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_turns" ADD COLUMN IF NOT EXISTS "transcript_segments" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "interview_turns" DROP COLUMN IF EXISTS "response_delay_ms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_turns" DROP COLUMN IF EXISTS "transcript_segments"`,
    );
  }
}
