import { QueryRunner } from 'typeorm';
import { MentorBookingLifecycle1780690000000 } from '../../../src/database/migrations/1780690000000-MentorBookingLifecycle';

describe('MentorBookingLifecycle1780690000000', () => {
  it('casts legacy mentor profile domain tags as a text array', async () => {
    const queries = await collectUpQueries();

    const legacyProfileInsert = queries.find((sql) =>
      sql.includes('INSERT INTO public.mentor_profiles'),
    );

    expect(legacyProfileInsert).toContain('ARRAY[]::text[]');
  });

  it('drops the old booking status check before writing new status values', async () => {
    const queries = await collectUpQueries();

    const dropStatusConstraint = queries.findIndex((sql) =>
      sql.includes('DROP CONSTRAINT IF EXISTS chk_mentor_bookings_status'),
    );
    const updatePaidToConfirmed = queries.findIndex((sql) =>
      sql.includes("SET status = 'CONFIRMED'"),
    );

    expect(dropStatusConstraint).toBeGreaterThanOrEqual(0);
    expect(updatePaidToConfirmed).toBeGreaterThanOrEqual(0);
    expect(dropStatusConstraint).toBeLessThan(updatePaidToConfirmed);
  });

  it('does not let failed mentor payment orders block checkout retries', async () => {
    const queries = await collectUpQueries();

    const mentorPaymentUniqueIndex = queries.find((sql) =>
      sql.includes('uq_payment_orders_mentor_booking_purpose'),
    );

    expect(mentorPaymentUniqueIndex).toContain("status IN ('PENDING', 'PAID')");
  });
});

async function collectUpQueries(): Promise<string[]> {
  const queries: string[] = [];
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;

  await new MentorBookingLifecycle1780690000000().up(queryRunner);

  return queries;
}
