import { MigrationInterface, QueryRunner } from 'typeorm';

export class PricingVouchers1781260000000 implements MigrationInterface {
  name = 'PricingVouchers1781260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE public.billing_plans
      SET
        price_vnd = CASE WHEN code = 'PREMIUM' THEN 199000 ELSE price_vnd END,
        is_active = CASE WHEN code = 'PRO' THEN false ELSE true END,
        sort_order = CASE WHEN code = 'FREE' THEN 0 WHEN code = 'PREMIUM' THEN 10 ELSE sort_order END,
        updated_at = now()
      WHERE code IN ('FREE', 'PRO', 'PREMIUM');
    `);
    await queryRunner.query(`
      INSERT INTO public.plan_features (plan_code, feature_key, limit_value, period)
      VALUES
        ('FREE', 'cv_upload', 5, 'MONTHLY'),
        ('FREE', 'cv_review', 1, 'MONTHLY'),
        ('FREE', 'cv_builder_create', 0, 'MONTHLY'),
        ('FREE', 'cv_builder_rewrite', 0, 'MONTHLY'),
        ('FREE', 'cv_builder_render_pdf', 0, 'MONTHLY'),
        ('FREE', 'cv_jd_match', 0, 'MONTHLY'),
        ('FREE', 'job_recommendation', 0, 'MONTHLY'),
        ('FREE', 'interview_session', 1, 'MONTHLY'),
        ('FREE', 'roadmap_generate', 0, 'MONTHLY'),
        ('PREMIUM', 'cv_upload', -1, 'MONTHLY'),
        ('PREMIUM', 'cv_review', 80, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_create', 30, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_rewrite', 30, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_render_pdf', -1, 'MONTHLY'),
        ('PREMIUM', 'cv_jd_match', 0, 'MONTHLY'),
        ('PREMIUM', 'job_recommendation', -1, 'MONTHLY'),
        ('PREMIUM', 'interview_session', 20, 'MONTHLY'),
        ('PREMIUM', 'roadmap_generate', 10, 'MONTHLY')
      ON CONFLICT (plan_code, feature_key) DO UPDATE SET
        limit_value = EXCLUDED.limit_value,
        period = EXCLUDED.period,
        updated_at = now();
    `);

    await queryRunner.query(`
      CREATE TABLE public.vouchers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(64) NOT NULL UNIQUE,
        discount_percent smallint NOT NULL,
        applicable_plan_code varchar NOT NULL REFERENCES public.billing_plans(code) ON DELETE RESTRICT,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        max_redemptions integer NOT NULL,
        per_user_limit integer NOT NULL DEFAULT 1,
        is_active boolean NOT NULL DEFAULT true,
        internal_note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_vouchers_code_normalized CHECK (code = upper(btrim(code))),
        CONSTRAINT chk_vouchers_discount CHECK (discount_percent BETWEEN 1 AND 99),
        CONSTRAINT chk_vouchers_period CHECK (starts_at < ends_at),
        CONSTRAINT chk_vouchers_limits CHECK (max_redemptions > 0 AND per_user_limit > 0),
        CONSTRAINT chk_vouchers_premium_only CHECK (applicable_plan_code = 'PREMIUM')
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_vouchers_active_period ON public.vouchers (is_active, starts_at, ends_at);`,
    );

    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        ADD COLUMN original_amount_vnd integer,
        ADD COLUMN discount_percent smallint NOT NULL DEFAULT 0,
        ADD COLUMN discount_amount_vnd integer NOT NULL DEFAULT 0,
        ADD COLUMN voucher_id uuid REFERENCES public.vouchers(id) ON DELETE RESTRICT,
        ADD COLUMN voucher_code varchar(64);
    `);
    await queryRunner.query(`
      UPDATE public.payment_orders SET original_amount_vnd = amount_vnd
      WHERE original_amount_vnd IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        ALTER COLUMN original_amount_vnd SET NOT NULL,
        ADD CONSTRAINT chk_payment_orders_pricing CHECK (
          original_amount_vnd > 0
          AND discount_percent BETWEEN 0 AND 99
          AND discount_amount_vnd >= 0
          AND amount_vnd = original_amount_vnd - discount_amount_vnd
          AND amount_vnd > 0
        );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_payment_orders_voucher ON public.payment_orders (voucher_id);`,
    );

    await queryRunner.query(`
      CREATE TABLE public.voucher_redemptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        voucher_id uuid NOT NULL REFERENCES public.vouchers(id) ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        payment_order_id uuid UNIQUE REFERENCES public.payment_orders(id) ON DELETE RESTRICT,
        status varchar NOT NULL,
        reserved_until timestamptz NOT NULL,
        redeemed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_voucher_redemptions_status CHECK (
          status IN ('RESERVED', 'REDEEMED', 'RELEASED')
        ),
        CONSTRAINT chk_voucher_redemptions_redeemed_at CHECK (
          (status = 'REDEEMED' AND redeemed_at IS NOT NULL)
          OR (status <> 'REDEEMED' AND redeemed_at IS NULL)
        )
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_voucher_redemptions_capacity
      ON public.voucher_redemptions (voucher_id, status, reserved_until);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_voucher_redemptions_user
      ON public.voucher_redemptions (voucher_id, user_id, status);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.voucher_redemptions;`);
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_payment_orders_voucher;`);
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        DROP CONSTRAINT IF EXISTS chk_payment_orders_pricing,
        DROP COLUMN IF EXISTS voucher_code,
        DROP COLUMN IF EXISTS voucher_id,
        DROP COLUMN IF EXISTS discount_amount_vnd,
        DROP COLUMN IF EXISTS discount_percent,
        DROP COLUMN IF EXISTS original_amount_vnd;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS public.vouchers;`);
    await queryRunner.query(`
      UPDATE public.billing_plans
      SET
        price_vnd = CASE WHEN code = 'PREMIUM' THEN 249000 ELSE price_vnd END,
        is_active = true,
        updated_at = now()
      WHERE code IN ('FREE', 'PRO', 'PREMIUM');
    `);
    await queryRunner.query(`
      INSERT INTO public.plan_features (plan_code, feature_key, limit_value, period)
      VALUES
        ('FREE', 'cv_review', 3, 'MONTHLY'),
        ('FREE', 'cv_upload', 10, 'MONTHLY'),
        ('FREE', 'cv_builder_create', 3, 'MONTHLY'),
        ('FREE', 'cv_builder_rewrite', 5, 'MONTHLY'),
        ('FREE', 'cv_builder_render_pdf', 3, 'MONTHLY'),
        ('FREE', 'cv_jd_match', 3, 'MONTHLY'),
        ('FREE', 'job_recommendation', 10, 'MONTHLY'),
        ('FREE', 'interview_session', 0, 'MONTHLY'),
        ('FREE', 'roadmap_generate', 1, 'MONTHLY'),
        ('PREMIUM', 'cv_review', 100, 'MONTHLY'),
        ('PREMIUM', 'cv_upload', 150, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_create', 60, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_rewrite', 300, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_render_pdf', 150, 'MONTHLY'),
        ('PREMIUM', 'cv_jd_match', 100, 'MONTHLY'),
        ('PREMIUM', 'job_recommendation', 300, 'MONTHLY'),
        ('PREMIUM', 'interview_session', 25, 'MONTHLY'),
        ('PREMIUM', 'roadmap_generate', 30, 'MONTHLY')
      ON CONFLICT (plan_code, feature_key) DO UPDATE SET
        limit_value = EXCLUDED.limit_value,
        period = EXCLUDED.period,
        updated_at = now();
    `);
  }
}
