import { MigrationInterface, QueryRunner } from 'typeorm';

export class MentorBookingLifecycle1780690000000 implements MigrationInterface {
  name = 'MentorBookingLifecycle1780690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.mentor_availability_slots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mentor_profile_id uuid NOT NULL REFERENCES public.mentor_profiles(id) ON DELETE CASCADE,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        status varchar NOT NULL DEFAULT 'OPEN',
        held_by_booking_id uuid,
        hold_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_mentor_slots_time CHECK (ends_at > starts_at),
        CONSTRAINT chk_mentor_slots_status CHECK (status IN ('OPEN', 'HELD', 'BOOKED', 'BLOCKED')),
        CONSTRAINT chk_mentor_slots_hold CHECK (
          (status = 'HELD' AND held_by_booking_id IS NOT NULL AND hold_expires_at IS NOT NULL)
          OR (status <> 'HELD' AND held_by_booking_id IS NULL AND hold_expires_at IS NULL)
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_slots_profile_start ON public.mentor_availability_slots (mentor_profile_id, starts_at);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_slots_status ON public.mentor_availability_slots (status);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_slots_hold_expiry ON public.mentor_availability_slots (hold_expires_at) WHERE status = 'HELD';`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.prevent_mentor_slot_overlap()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.status IN ('OPEN', 'HELD', 'BOOKED') AND EXISTS (
          SELECT 1
          FROM public.mentor_availability_slots existing
          WHERE existing.mentor_profile_id = NEW.mentor_profile_id
            AND existing.id <> NEW.id
            AND existing.status IN ('OPEN', 'HELD', 'BOOKED')
            AND existing.starts_at < NEW.ends_at
            AND existing.ends_at > NEW.starts_at
        ) THEN
          RAISE EXCEPTION 'mentor availability slot overlaps an existing slot'
            USING ERRCODE = '23P01';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_mentor_slot_no_overlap
      BEFORE INSERT OR UPDATE OF mentor_profile_id, starts_at, ends_at, status
      ON public.mentor_availability_slots
      FOR EACH ROW EXECUTE FUNCTION public.prevent_mentor_slot_overlap();
    `);

    await queryRunner.query(`
      ALTER TABLE public.mentor_bookings
        ADD COLUMN IF NOT EXISTS mentor_profile_id uuid,
        ADD COLUMN IF NOT EXISTS availability_slot_id uuid,
        ADD COLUMN IF NOT EXISTS remaining_due_at timestamptz,
        ADD COLUMN IF NOT EXISTS meeting_url text,
        ADD COLUMN IF NOT EXISTS completed_at timestamptz,
        ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
        ADD COLUMN IF NOT EXISTS cancelled_by uuid,
        ADD COLUMN IF NOT EXISTS cancellation_reason text,
        ADD COLUMN IF NOT EXISTS refund_status varchar NOT NULL DEFAULT 'NOT_REQUIRED',
        ADD COLUMN IF NOT EXISTS refund_note text;
    `);

    // Old checkout accepted any user as a mentor. Preserve those rows by creating a
    // suspended legacy profile before attaching the new profile/slot foreign keys.
    await queryRunner.query(`
      INSERT INTO public.mentor_profiles (
        user_id, slug, status, session_price_vnd, session_duration_minutes,
        currency, is_accepting_bookings, domain_tags
      )
      SELECT DISTINCT
        booking.mentor_id,
        'legacy-mentor-' || booking.mentor_id::text,
        'SUSPENDED',
        LEAST(GREATEST(booking.total_amount_vnd, 50000), 10000000),
        60,
        'VND',
        false,
        ARRAY[]::text[]
      FROM public.mentor_bookings booking
      LEFT JOIN public.mentor_profiles profile ON profile.user_id = booking.mentor_id
      WHERE profile.id IS NULL
      ON CONFLICT (user_id) DO NOTHING;
    `);

    await queryRunner.query(`
      INSERT INTO public.mentor_availability_slots (
        id, mentor_profile_id, starts_at, ends_at, status, created_at
      )
      SELECT
        booking.id,
        profile.id,
        COALESCE(booking.slot_start, booking.created_at + interval '24 hours'),
        GREATEST(
          COALESCE(
            booking.slot_end,
            COALESCE(booking.slot_start, booking.created_at + interval '24 hours') + interval '60 minutes'
          ),
          COALESCE(booking.slot_start, booking.created_at + interval '24 hours') + interval '1 minute'
        ),
        'BLOCKED',
        booking.created_at
      FROM public.mentor_bookings booking
      JOIN public.mentor_profiles profile ON profile.user_id = booking.mentor_id
      WHERE booking.availability_slot_id IS NULL
      ON CONFLICT (id) DO NOTHING;
    `);

    await queryRunner.query(`
      UPDATE public.mentor_bookings booking
      SET mentor_profile_id = profile.id,
          availability_slot_id = booking.id
      FROM public.mentor_profiles profile
      WHERE profile.user_id = booking.mentor_id
        AND (booking.mentor_profile_id IS NULL OR booking.availability_slot_id IS NULL);
    `);
    await queryRunner.query(
      `ALTER TABLE public.mentor_bookings DROP CONSTRAINT IF EXISTS chk_mentor_bookings_status;`,
    );
    await queryRunner.query(
      `UPDATE public.mentor_bookings SET status = 'CONFIRMED' WHERE status = 'PAID';`,
    );
    await queryRunner.query(
      `UPDATE public.mentor_bookings SET status = 'AWAITING_REMAINING' WHERE status = 'AWAITING_MENTOR_ACCEPT';`,
    );
    await queryRunner.query(`
      ALTER TABLE public.mentor_bookings
        ALTER COLUMN mentor_profile_id SET NOT NULL,
        ALTER COLUMN availability_slot_id SET NOT NULL,
        ADD CONSTRAINT fk_mentor_bookings_profile
          FOREIGN KEY (mentor_profile_id) REFERENCES public.mentor_profiles(id) ON DELETE RESTRICT,
        ADD CONSTRAINT fk_mentor_bookings_slot
          FOREIGN KEY (availability_slot_id) REFERENCES public.mentor_availability_slots(id) ON DELETE RESTRICT,
        ADD CONSTRAINT uq_mentor_bookings_slot UNIQUE (availability_slot_id),
        ADD CONSTRAINT fk_mentor_bookings_cancelled_by
          FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON DELETE SET NULL,
        ADD CONSTRAINT chk_mentor_bookings_status CHECK (
          status IN ('PENDING_DEPOSIT', 'AWAITING_REMAINING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED')
        ),
        ADD CONSTRAINT chk_mentor_bookings_refund_status CHECK (
          refund_status IN ('NOT_REQUIRED', 'PENDING', 'PROCESSED', 'REJECTED')
        );
    `);
    await queryRunner.query(
      `ALTER TABLE public.mentor_availability_slots ADD CONSTRAINT fk_mentor_slots_held_booking FOREIGN KEY (held_by_booking_id) REFERENCES public.mentor_bookings(id) ON DELETE RESTRICT;`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_bookings_profile ON public.mentor_bookings (mentor_profile_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_bookings_refund ON public.mentor_bookings (refund_status);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_bookings_remaining_due ON public.mentor_bookings (remaining_due_at) WHERE status = 'AWAITING_REMAINING';`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_mentor_booking_purpose
      ON public.payment_orders (target_id, purpose)
      WHERE target_type = 'MENTOR_BOOKING'
        AND target_id IS NOT NULL
        AND status IN ('PENDING', 'PAID');
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.mentor_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id uuid NOT NULL UNIQUE REFERENCES public.mentor_bookings(id) ON DELETE CASCADE,
        student_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        mentor_profile_id uuid NOT NULL REFERENCES public.mentor_profiles(id) ON DELETE CASCADE,
        rating smallint NOT NULL,
        comment text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_mentor_reviews_rating CHECK (rating BETWEEN 1 AND 5)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_reviews_student ON public.mentor_reviews (student_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_reviews_profile ON public.mentor_reviews (mentor_profile_id);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.mentor_reviews;`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.uq_payment_orders_mentor_booking_purpose;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.mentor_availability_slots DROP CONSTRAINT IF EXISTS fk_mentor_slots_held_booking;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.mentor_bookings DROP CONSTRAINT IF EXISTS chk_mentor_bookings_status;`,
    );
    await queryRunner.query(
      `UPDATE public.mentor_bookings SET status = 'PAID' WHERE status IN ('CONFIRMED', 'COMPLETED');`,
    );
    await queryRunner.query(
      `UPDATE public.mentor_bookings SET status = 'CANCELLED' WHERE status = 'EXPIRED';`,
    );
    await queryRunner.query(`
      ALTER TABLE public.mentor_bookings
        DROP CONSTRAINT IF EXISTS fk_mentor_bookings_profile,
        DROP CONSTRAINT IF EXISTS fk_mentor_bookings_slot,
        DROP CONSTRAINT IF EXISTS uq_mentor_bookings_slot,
        DROP CONSTRAINT IF EXISTS fk_mentor_bookings_cancelled_by,
        DROP CONSTRAINT IF EXISTS chk_mentor_bookings_refund_status,
        DROP COLUMN IF EXISTS mentor_profile_id,
        DROP COLUMN IF EXISTS availability_slot_id,
        DROP COLUMN IF EXISTS remaining_due_at,
        DROP COLUMN IF EXISTS meeting_url,
        DROP COLUMN IF EXISTS completed_at,
        DROP COLUMN IF EXISTS cancelled_at,
        DROP COLUMN IF EXISTS cancelled_by,
        DROP COLUMN IF EXISTS cancellation_reason,
        DROP COLUMN IF EXISTS refund_status,
        DROP COLUMN IF EXISTS refund_note,
        ADD CONSTRAINT chk_mentor_bookings_status CHECK (
          status IN ('PENDING_DEPOSIT', 'AWAITING_MENTOR_ACCEPT', 'AWAITING_REMAINING', 'PAID', 'CANCELLED')
        );
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_mentor_slot_no_overlap ON public.mentor_availability_slots;`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.prevent_mentor_slot_overlap();`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.mentor_availability_slots;`);
  }
}
