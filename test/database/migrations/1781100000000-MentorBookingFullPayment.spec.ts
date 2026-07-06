import { QueryRunner } from 'typeorm';
import { MentorBookingFullPayment1781100000000 } from '../../../src/database/migrations/1781100000000-MentorBookingFullPayment';

describe('MentorBookingFullPayment1781100000000', () => {
  it('adds full-payment mentor booking compatibility changes', async () => {
    const queries = await collectUpQueries();
    const sql = queries.join('\n');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS payment_order_id uuid');
    expect(sql).toContain("UPDATE public.mentor_bookings SET status = 'PENDING_PAYMENT'");
    expect(sql).toContain(
      "status IN ('PENDING_PAYMENT', 'AWAITING_REMAINING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED')",
    );
    expect(sql).toContain(
      "purpose IN ('SUBSCRIPTION', 'MENTOR_BOOKING', 'MENTOR_DEPOSIT', 'MENTOR_REMAINING')",
    );
  });

  it('restores the previous mentor booking status constraint on rollback', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    await new MentorBookingFullPayment1781100000000().down(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain("UPDATE public.mentor_bookings SET status = 'PENDING_DEPOSIT'");
    expect(sql).toContain('DROP COLUMN IF EXISTS payment_order_id');
    expect(sql).toContain(
      "status IN ('PENDING_DEPOSIT', 'AWAITING_REMAINING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED')",
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

  await new MentorBookingFullPayment1781100000000().up(queryRunner);

  return queries;
}
