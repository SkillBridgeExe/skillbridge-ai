import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreditPackages1785600000000 implements MigrationInterface {
  name = 'CreditPackages1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.billing_plans
        DROP CONSTRAINT IF EXISTS chk_billing_plans_category,
        ADD CONSTRAINT chk_billing_plans_category
          CHECK (category IN ('SUBSCRIPTION', 'MENTOR_PACKAGE', 'CREDIT_PACKAGE'));
    `);
    await queryRunner.query(`
      CREATE TABLE public.billing_credit_packages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_code varchar NOT NULL UNIQUE REFERENCES public.billing_plans(code) ON DELETE CASCADE,
        credit_type varchar NOT NULL,
        units integer NOT NULL,
        CONSTRAINT chk_billing_credit_packages_type
          CHECK (credit_type IN ('CV_ANALYSIS', 'INTERVIEW_SESSION')),
        CONSTRAINT chk_billing_credit_packages_units CHECK (units > 0)
      );
    `);
    await queryRunner.query(`
      INSERT INTO public.billing_plans
        (code, name, description, category, interval, price_vnd, currency, is_active, sort_order)
      VALUES
        ('CV_ANALYSIS_PACK', 'CV analysis credits', 'Four CV diagnosis or CV–JD match credits', 'CREDIT_PACKAGE', 'ONE_TIME', 20000, 'VND', true, 100),
        ('INTERVIEW_PACK', 'Interview credits', 'One AI interview session credit', 'CREDIT_PACKAGE', 'ONE_TIME', 20000, 'VND', true, 110);
    `);
    await queryRunner.query(`
      INSERT INTO public.billing_credit_packages (plan_code, credit_type, units)
      VALUES ('CV_ANALYSIS_PACK', 'CV_ANALYSIS', 4), ('INTERVIEW_PACK', 'INTERVIEW_SESSION', 1);
    `);
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        ADD COLUMN credit_type varchar,
        ADD COLUMN credit_units integer,
        DROP CONSTRAINT IF EXISTS chk_payment_orders_purpose,
        ADD CONSTRAINT chk_payment_orders_purpose CHECK (
          purpose IN ('SUBSCRIPTION', 'CREDIT_PACKAGE', 'MENTOR_BOOKING', 'MENTOR_DEPOSIT', 'MENTOR_REMAINING')
        ),
        DROP CONSTRAINT IF EXISTS chk_payment_orders_target_type,
        ADD CONSTRAINT chk_payment_orders_target_type CHECK (
          target_type IN ('SUBSCRIPTION', 'CREDIT_PACKAGE', 'MENTOR_BOOKING')
        ),
        ADD CONSTRAINT chk_payment_orders_credit_snapshot CHECK (
          (purpose = 'CREDIT_PACKAGE' AND credit_type IN ('CV_ANALYSIS', 'INTERVIEW_SESSION') AND credit_units > 0)
          OR (purpose <> 'CREDIT_PACKAGE' AND credit_type IS NULL AND credit_units IS NULL)
        );
    `);
    await queryRunner.query(`
      CREATE TABLE public.user_credit_balances (
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        credit_type varchar NOT NULL,
        balance integer NOT NULL DEFAULT 0,
        updated_at timestamptz,
        PRIMARY KEY (user_id, credit_type),
        CONSTRAINT chk_user_credit_balances_type CHECK (credit_type IN ('CV_ANALYSIS', 'INTERVIEW_SESSION')),
        CONSTRAINT chk_user_credit_balances_balance CHECK (balance >= 0)
      );
    `);
    await queryRunner.query(`
      CREATE TABLE public.credit_usage_reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        credit_type varchar NOT NULL,
        status varchar NOT NULL,
        source_type varchar,
        source_id uuid,
        reserved_until timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_credit_usage_reservations_type CHECK (credit_type IN ('CV_ANALYSIS', 'INTERVIEW_SESSION')),
        CONSTRAINT chk_credit_usage_reservations_status CHECK (status IN ('RESERVED', 'CONSUMED', 'RELEASED'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_credit_usage_reservations_active ON public.credit_usage_reservations (user_id, credit_type, status, reserved_until);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.credit_usage_reservations;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.user_credit_balances;`);
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        DROP CONSTRAINT IF EXISTS chk_payment_orders_credit_snapshot,
        DROP COLUMN IF EXISTS credit_units,
        DROP COLUMN IF EXISTS credit_type,
        DROP CONSTRAINT IF EXISTS chk_payment_orders_target_type,
        ADD CONSTRAINT chk_payment_orders_target_type CHECK (target_type IN ('SUBSCRIPTION', 'MENTOR_BOOKING')),
        DROP CONSTRAINT IF EXISTS chk_payment_orders_purpose,
        ADD CONSTRAINT chk_payment_orders_purpose CHECK (purpose IN ('SUBSCRIPTION', 'MENTOR_BOOKING', 'MENTOR_DEPOSIT', 'MENTOR_REMAINING'));
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS public.billing_credit_packages;`);
    await queryRunner.query(
      `DELETE FROM public.billing_plans WHERE code IN ('CV_ANALYSIS_PACK', 'INTERVIEW_PACK');`,
    );
    await queryRunner.query(`
      ALTER TABLE public.billing_plans
        DROP CONSTRAINT IF EXISTS chk_billing_plans_category,
        ADD CONSTRAINT chk_billing_plans_category CHECK (category IN ('SUBSCRIPTION', 'MENTOR_PACKAGE'));
    `);
  }
}
