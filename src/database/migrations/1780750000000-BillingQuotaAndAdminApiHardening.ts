import { MigrationInterface, QueryRunner } from 'typeorm';

export class BillingQuotaAndAdminApiHardening1780750000000 implements MigrationInterface {
  name = 'BillingQuotaAndAdminApiHardening1780750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE public.billing_plans
      SET price_vnd = CASE code
          WHEN 'FREE' THEN 0
          WHEN 'PRO' THEN 99000
          WHEN 'PREMIUM' THEN 249000
          ELSE price_vnd
        END,
        category = 'SUBSCRIPTION',
        interval = 'MONTHLY',
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
        ('PRO', 'cv_review', 30, 'MONTHLY'),
        ('PRO', 'cv_upload', 50, 'MONTHLY'),
        ('PRO', 'cv_builder_create', 20, 'MONTHLY'),
        ('PRO', 'cv_builder_rewrite', 100, 'MONTHLY'),
        ('PRO', 'cv_builder_render_pdf', 50, 'MONTHLY'),
        ('PRO', 'cv_jd_match', 30, 'MONTHLY'),
        ('PRO', 'job_recommendation', 100, 'MONTHLY'),
        ('PRO', 'interview_session', 5, 'MONTHLY'),
        ('PRO', 'roadmap_generate', 10, 'MONTHLY'),
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE public.billing_plans
      SET price_vnd = CASE code
          WHEN 'FREE' THEN 0
          WHEN 'PRO' THEN 99000
          WHEN 'PREMIUM' THEN 199000
          ELSE price_vnd
        END,
        updated_at = now()
      WHERE code IN ('FREE', 'PRO', 'PREMIUM');
    `);

    await queryRunner.query(`
      INSERT INTO public.plan_features (plan_code, feature_key, limit_value, period)
      VALUES
        ('FREE', 'cv_review', 5, 'DAILY'),
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
