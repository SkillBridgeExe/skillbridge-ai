import { MigrationInterface, QueryRunner } from 'typeorm';

export class BillingPayosInit1780620000000 implements MigrationInterface {
  name = 'BillingPayosInit1780620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.billing_plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar NOT NULL UNIQUE,
        name varchar NOT NULL,
        description text,
        category varchar NOT NULL,
        interval varchar NOT NULL,
        price_vnd integer NOT NULL DEFAULT 0,
        currency varchar NOT NULL DEFAULT 'VND',
        is_active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_billing_plans_category CHECK (category IN ('SUBSCRIPTION', 'MENTOR_PACKAGE')),
        CONSTRAINT chk_billing_plans_interval CHECK (interval IN ('MONTHLY', 'ONE_TIME')),
        CONSTRAINT chk_billing_plans_price CHECK (price_vnd >= 0)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_billing_plans_category ON public.billing_plans (category);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.plan_features (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_code varchar NOT NULL REFERENCES public.billing_plans(code) ON DELETE CASCADE,
        feature_key varchar NOT NULL,
        limit_value integer NOT NULL,
        period varchar NOT NULL DEFAULT 'MONTHLY',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT uq_plan_features_plan_feature UNIQUE (plan_code, feature_key),
        CONSTRAINT chk_plan_features_period CHECK (period IN ('MONTHLY')),
        CONSTRAINT chk_plan_features_limit CHECK (limit_value >= -1),
        CONSTRAINT chk_plan_features_key CHECK (
          feature_key IN (
            'cv_review',
            'cv_upload',
            'cv_builder_create',
            'cv_builder_rewrite',
            'cv_builder_render_pdf',
            'cv_jd_match',
            'job_recommendation',
            'interview_session',
            'roadmap_generate'
          )
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_plan_features_plan_code ON public.plan_features (plan_code);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_plan_features_feature_key ON public.plan_features (feature_key);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.payment_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        provider varchar NOT NULL DEFAULT 'PAYOS',
        order_code bigint NOT NULL UNIQUE,
        amount_vnd integer NOT NULL,
        currency varchar NOT NULL DEFAULT 'VND',
        purpose varchar NOT NULL,
        target_type varchar NOT NULL,
        target_id uuid,
        plan_code varchar REFERENCES public.billing_plans(code) ON DELETE SET NULL,
        status varchar NOT NULL,
        description varchar NOT NULL,
        checkout_url text,
        payment_link_id varchar,
        qr_code text,
        provider_payload jsonb,
        paid_at timestamptz,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_payment_orders_amount CHECK (amount_vnd > 0),
        CONSTRAINT chk_payment_orders_purpose CHECK (
          purpose IN ('SUBSCRIPTION', 'MENTOR_DEPOSIT', 'MENTOR_REMAINING')
        ),
        CONSTRAINT chk_payment_orders_target_type CHECK (
          target_type IN ('SUBSCRIPTION', 'MENTOR_BOOKING')
        ),
        CONSTRAINT chk_payment_orders_status CHECK (
          status IN ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED')
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON public.payment_orders (user_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_orders_purpose ON public.payment_orders (purpose);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_orders_target ON public.payment_orders (target_type, target_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON public.payment_orders (status);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.user_subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        plan_code varchar NOT NULL REFERENCES public.billing_plans(code) ON DELETE RESTRICT,
        status varchar NOT NULL,
        current_period_start timestamptz NOT NULL,
        current_period_end timestamptz NOT NULL,
        source_payment_order_id uuid REFERENCES public.payment_orders(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_user_subscriptions_status CHECK (
          status IN ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED')
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON public.user_subscriptions (user_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan ON public.user_subscriptions (plan_code);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON public.user_subscriptions (status);`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_user_subscriptions_one_active
      ON public.user_subscriptions (user_id)
      WHERE status = 'ACTIVE';
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider varchar NOT NULL DEFAULT 'PAYOS',
        order_code bigint,
        reference varchar,
        payment_link_id varchar,
        signature varchar,
        event_hash varchar NOT NULL UNIQUE,
        raw_payload jsonb NOT NULL,
        verified boolean NOT NULL DEFAULT false,
        processed boolean NOT NULL DEFAULT false,
        processing_error text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_order ON public.payment_webhook_events (order_code);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_reference ON public.payment_webhook_events (reference);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.usage_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        feature_key varchar NOT NULL,
        subscription_id uuid REFERENCES public.user_subscriptions(id) ON DELETE SET NULL,
        source_type varchar,
        source_id uuid,
        used_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_usage_events_feature_key CHECK (
          feature_key IN (
            'cv_review',
            'cv_upload',
            'cv_builder_create',
            'cv_builder_rewrite',
            'cv_builder_render_pdf',
            'cv_jd_match',
            'job_recommendation',
            'interview_session',
            'roadmap_generate'
          )
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_usage_events_user ON public.usage_events (user_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_usage_events_feature ON public.usage_events (feature_key);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_usage_events_used_at ON public.usage_events (used_at);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.mentor_bookings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        mentor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        plan_code varchar REFERENCES public.billing_plans(code) ON DELETE SET NULL,
        status varchar NOT NULL,
        package_snapshot jsonb,
        slot_start timestamptz,
        slot_end timestamptz,
        total_amount_vnd integer NOT NULL,
        deposit_amount_vnd integer NOT NULL,
        remaining_amount_vnd integer NOT NULL,
        deposit_payment_order_id uuid REFERENCES public.payment_orders(id) ON DELETE SET NULL,
        remaining_payment_order_id uuid REFERENCES public.payment_orders(id) ON DELETE SET NULL,
        accepted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_mentor_bookings_status CHECK (
          status IN (
            'PENDING_DEPOSIT',
            'AWAITING_MENTOR_ACCEPT',
            'AWAITING_REMAINING',
            'PAID',
            'CANCELLED'
          )
        ),
        CONSTRAINT chk_mentor_bookings_amounts CHECK (
          total_amount_vnd > 0 AND deposit_amount_vnd > 0 AND remaining_amount_vnd >= 0
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_bookings_student ON public.mentor_bookings (student_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_bookings_mentor ON public.mentor_bookings (mentor_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_bookings_status ON public.mentor_bookings (status);`,
    );

    await this.seedDefaultPlans(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.mentor_bookings;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.usage_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.payment_webhook_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.user_subscriptions;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.payment_orders;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.plan_features;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.billing_plans;`);
  }

  private async seedDefaultPlans(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO public.billing_plans (code, name, description, category, interval, price_vnd, sort_order)
      VALUES
        ('FREE', 'Free', 'Free monthly starter plan', 'SUBSCRIPTION', 'MONTHLY', 0, 0),
        ('PRO', 'Pro', 'Monthly AI career tools plan', 'SUBSCRIPTION', 'MONTHLY', 99000, 10),
        ('PREMIUM', 'Premium', 'Monthly advanced AI career tools plan', 'SUBSCRIPTION', 'MONTHLY', 199000, 20),
        ('MENTOR_60', 'Mentor 60 minutes', 'One 60-minute mentor session package', 'MENTOR_PACKAGE', 'ONE_TIME', 500000, 100)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        interval = EXCLUDED.interval,
        price_vnd = EXCLUDED.price_vnd,
        sort_order = EXCLUDED.sort_order,
        updated_at = now();
    `);

    await queryRunner.query(`
      INSERT INTO public.plan_features (plan_code, feature_key, limit_value, period)
      VALUES
        ('FREE', 'cv_review', 3, 'MONTHLY'),
        ('FREE', 'cv_upload', 10, 'MONTHLY'),
        ('FREE', 'cv_builder_create', 3, 'MONTHLY'),
        ('FREE', 'cv_builder_rewrite', 0, 'MONTHLY'),
        ('FREE', 'cv_builder_render_pdf', 3, 'MONTHLY'),
        ('FREE', 'cv_jd_match', 3, 'MONTHLY'),
        ('FREE', 'job_recommendation', 10, 'MONTHLY'),
        ('FREE', 'interview_session', 0, 'MONTHLY'),
        ('FREE', 'roadmap_generate', 1, 'MONTHLY'),
        ('PRO', 'cv_review', 30, 'MONTHLY'),
        ('PRO', 'cv_upload', 50, 'MONTHLY'),
        ('PRO', 'cv_builder_create', 20, 'MONTHLY'),
        ('PRO', 'cv_builder_rewrite', 100, 'MONTHLY'),
        ('PRO', 'cv_builder_render_pdf', 50, 'MONTHLY'),
        ('PRO', 'cv_jd_match', 30, 'MONTHLY'),
        ('PRO', 'job_recommendation', -1, 'MONTHLY'),
        ('PRO', 'interview_session', 5, 'MONTHLY'),
        ('PRO', 'roadmap_generate', 10, 'MONTHLY'),
        ('PREMIUM', 'cv_review', -1, 'MONTHLY'),
        ('PREMIUM', 'cv_upload', -1, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_create', -1, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_rewrite', -1, 'MONTHLY'),
        ('PREMIUM', 'cv_builder_render_pdf', -1, 'MONTHLY'),
        ('PREMIUM', 'cv_jd_match', -1, 'MONTHLY'),
        ('PREMIUM', 'job_recommendation', -1, 'MONTHLY'),
        ('PREMIUM', 'interview_session', 30, 'MONTHLY'),
        ('PREMIUM', 'roadmap_generate', -1, 'MONTHLY')
      ON CONFLICT (plan_code, feature_key) DO UPDATE SET
        limit_value = EXCLUDED.limit_value,
        period = EXCLUDED.period,
        updated_at = now();
    `);
  }
}
