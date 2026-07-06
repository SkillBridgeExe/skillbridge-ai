import { MigrationInterface, QueryRunner } from 'typeorm';

export class MentorBookingStudentGoal1781080000000 implements MigrationInterface {
  name = 'MentorBookingStudentGoal1781080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.mentor_bookings ADD COLUMN IF NOT EXISTS student_goal text;',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.mentor_bookings DROP COLUMN IF EXISTS student_goal;',
    );
  }
}
