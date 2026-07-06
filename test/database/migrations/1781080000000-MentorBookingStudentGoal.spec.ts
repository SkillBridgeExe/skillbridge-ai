import { QueryRunner } from 'typeorm';
import { MentorBookingStudentGoal1781080000000 } from '../../../src/database/migrations/1781080000000-MentorBookingStudentGoal';

describe('MentorBookingStudentGoal1781080000000', () => {
  it('adds a nullable student_goal column for backward-compatible mentor booking intake', async () => {
    const queries = await collectUpQueries();

    expect(queries).toContain(
      'ALTER TABLE public.mentor_bookings ADD COLUMN IF NOT EXISTS student_goal text;',
    );
  });

  it('drops the student_goal column when reverting the migration', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    await new MentorBookingStudentGoal1781080000000().down(queryRunner);

    expect(queries).toContain(
      'ALTER TABLE public.mentor_bookings DROP COLUMN IF EXISTS student_goal;',
    );
  });
});

async function collectUpQueries(): Promise<string[]> {
  const queries: string[] = [];
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;

  await new MentorBookingStudentGoal1781080000000().up(queryRunner);

  return queries;
}
