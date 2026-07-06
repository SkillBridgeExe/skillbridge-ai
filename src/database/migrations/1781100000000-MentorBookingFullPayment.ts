import { MigrationInterface, QueryRunner } from 'typeorm';

export class MentorBookingFullPayment1781100000000 implements MigrationInterface {
  name = 'MentorBookingFullPayment1781100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.mentor_bookings
        ADD COLUMN IF NOT EXISTS payment_order_id uuid;
    `);
    await queryRunner.query(`
      UPDATE public.mentor_bookings
      SET payment_order_id = COALESCE(payment_order_id, remaining_payment_order_id, deposit_payment_order_id)
      WHERE payment_order_id IS NULL
        AND status IN ('CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED');
    `);
    await queryRunner.query(`
      UPDATE public.mentor_bookings SET status = 'PENDING_PAYMENT' WHERE status = 'PENDING_DEPOSIT';
    `);
    await queryRunner.query(`
      ALTER TABLE public.mentor_bookings
        DROP CONSTRAINT IF EXISTS chk_mentor_bookings_status,
        ADD CONSTRAINT chk_mentor_bookings_status CHECK (
          status IN ('PENDING_PAYMENT', 'AWAITING_REMAINING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED')
        );
    `);
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        DROP CONSTRAINT IF EXISTS chk_payment_orders_purpose,
        ADD CONSTRAINT chk_payment_orders_purpose CHECK (
          purpose IN ('SUBSCRIPTION', 'MENTOR_BOOKING', 'MENTOR_DEPOSIT', 'MENTOR_REMAINING')
        );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mentor_bookings_payment_order
      ON public.mentor_bookings (payment_order_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_mentor_bookings_payment_order;`);
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        DROP CONSTRAINT IF EXISTS chk_payment_orders_purpose,
        ADD CONSTRAINT chk_payment_orders_purpose CHECK (
          purpose IN ('SUBSCRIPTION', 'MENTOR_DEPOSIT', 'MENTOR_REMAINING')
        );
    `);
    await queryRunner.query(`
      ALTER TABLE public.mentor_bookings
        DROP CONSTRAINT IF EXISTS chk_mentor_bookings_status;
    `);
    await queryRunner.query(`
      UPDATE public.mentor_bookings SET status = 'PENDING_DEPOSIT' WHERE status = 'PENDING_PAYMENT';
    `);
    await queryRunner.query(`
      ALTER TABLE public.mentor_bookings
        ADD CONSTRAINT chk_mentor_bookings_status CHECK (
          status IN ('PENDING_DEPOSIT', 'AWAITING_REMAINING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED')
        ),
        DROP COLUMN IF EXISTS payment_order_id;
    `);
  }
}
