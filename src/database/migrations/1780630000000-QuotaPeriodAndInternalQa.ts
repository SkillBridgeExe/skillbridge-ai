import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuotaPeriodAndInternalQa1780630000000 implements MigrationInterface {
  name = 'QuotaPeriodAndInternalQa1780630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.plan_features
      DROP CONSTRAINT IF EXISTS chk_plan_features_period;
    `);
    await queryRunner.query(`
      ALTER TABLE public.plan_features
      ADD CONSTRAINT chk_plan_features_period CHECK (period IN ('DAILY', 'MONTHLY'));
    `);

    await queryRunner.query(`
      INSERT INTO public.billing_plans
        (code, name, description, category, interval, price_vnd, sort_order, metadata)
      VALUES
        (
          'INTERNAL_QA',
          'Internal QA',
          'Unlimited internal testing plan',
          'SUBSCRIPTION',
          'MONTHLY',
          0,
          -10,
          '{"internal": true}'::jsonb
        )
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        interval = EXCLUDED.interval,
        price_vnd = EXCLUDED.price_vnd,
        sort_order = EXCLUDED.sort_order,
        metadata = EXCLUDED.metadata,
        is_active = true,
        updated_at = now();
    `);

    await queryRunner.query(`
      INSERT INTO public.plan_features (plan_code, feature_key, limit_value, period)
      VALUES
        ('FREE', 'cv_review', 5, 'DAILY'),
        ('INTERNAL_QA', 'cv_review', -1, 'MONTHLY'),
        ('INTERNAL_QA', 'cv_upload', -1, 'MONTHLY'),
        ('INTERNAL_QA', 'cv_builder_create', -1, 'MONTHLY'),
        ('INTERNAL_QA', 'cv_builder_rewrite', -1, 'MONTHLY'),
        ('INTERNAL_QA', 'cv_builder_render_pdf', -1, 'MONTHLY'),
        ('INTERNAL_QA', 'cv_jd_match', -1, 'MONTHLY'),
        ('INTERNAL_QA', 'job_recommendation', -1, 'MONTHLY'),
        ('INTERNAL_QA', 'interview_session', -1, 'MONTHLY'),
        ('INTERNAL_QA', 'roadmap_generate', -1, 'MONTHLY')
      ON CONFLICT (plan_code, feature_key) DO UPDATE SET
        limit_value = EXCLUDED.limit_value,
        period = EXCLUDED.period,
        updated_at = now();
    `);

    await queryRunner.query(`
      WITH admin_user AS (
        SELECT id
        FROM public.users
        WHERE email_normalized = 'admin@skillbridge.com'
           OR lower(email) = 'admin@skillbridge.com'
        LIMIT 1
      ),
      expired_existing AS (
        UPDATE public.user_subscriptions us
        SET status = 'EXPIRED', updated_at = now()
        FROM admin_user au
        WHERE us.user_id = au.id
          AND us.status = 'ACTIVE'
          AND us.plan_code <> 'INTERNAL_QA'
        RETURNING us.id
      )
      INSERT INTO public.user_subscriptions
        (user_id, plan_code, status, current_period_start, current_period_end)
      SELECT
        au.id,
        'INTERNAL_QA',
        'ACTIVE',
        now(),
        '9999-12-31T00:00:00.000Z'::timestamptz
      FROM admin_user au
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.user_subscriptions us
        WHERE us.user_id = au.id
          AND us.status = 'ACTIVE'
          AND us.plan_code = 'INTERNAL_QA'
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM public.user_subscriptions
      WHERE plan_code = 'INTERNAL_QA';
    `);
    await queryRunner.query(`
      DELETE FROM public.plan_features
      WHERE plan_code = 'INTERNAL_QA';
    `);
    await queryRunner.query(`
      DELETE FROM public.billing_plans
      WHERE code = 'INTERNAL_QA';
    `);
    await queryRunner.query(`
      UPDATE public.plan_features
      SET limit_value = 3, period = 'MONTHLY', updated_at = now()
      WHERE plan_code = 'FREE'
        AND feature_key = 'cv_review';
    `);
    await queryRunner.query(`
      UPDATE public.plan_features
      SET period = 'MONTHLY', updated_at = now()
      WHERE period = 'DAILY';
    `);
    await queryRunner.query(`
      ALTER TABLE public.plan_features
      DROP CONSTRAINT IF EXISTS chk_plan_features_period;
    `);
    await queryRunner.query(`
      ALTER TABLE public.plan_features
      ADD CONSTRAINT chk_plan_features_period CHECK (period IN ('MONTHLY'));
    `);
  }
}
