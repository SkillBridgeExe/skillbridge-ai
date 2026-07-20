import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * I-PACE: the answer time budget the engine handed out for this question, in seconds.
 *
 * Stored rather than recomputed at read time so the report can state the budget a turn was
 * ACTUALLY given, even after the constants change. Nullable: legacy turns and reviewed live
 * turns were never issued one, and a client that gets null simply shows no pacing UI.
 */
export class InterviewTurnTimeBudget1781230000000 implements MigrationInterface {
  name = 'InterviewTurnTimeBudget1781230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "interview_turns" ADD COLUMN IF NOT EXISTS "time_budget_seconds" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "interview_turns" DROP COLUMN IF EXISTS "time_budget_seconds"`,
    );
  }
}
