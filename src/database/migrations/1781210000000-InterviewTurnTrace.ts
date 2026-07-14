import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * I-CONSIST-2: persist the per-turn decision trace (action, reasons incl. score_capped_* /
 * depth_downgraded_*, depth, budget, confidence) so the final report can show honest score
 * provenance — not only the live response.
 */
export class InterviewTurnTrace1781210000000 implements MigrationInterface {
  name = 'InterviewTurnTrace1781210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "interview_turns" ADD COLUMN IF NOT EXISTS "turn_trace" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "interview_turns" DROP COLUMN IF EXISTS "turn_trace"`);
  }
}
