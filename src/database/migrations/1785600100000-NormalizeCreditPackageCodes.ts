import { MigrationInterface, QueryRunner } from 'typeorm';

export class NormalizeCreditPackageCodes1785600100000 implements MigrationInterface {
  name = 'NormalizeCreditPackageCodes1785600100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        mapping text[];
        legacy_code text;
        stable_code text;
        legacy_package_id uuid;
        stable_package_id uuid;
      BEGIN
        FOREACH mapping SLICE 1 IN ARRAY ARRAY[
          ARRAY['CV_ANALYSIS_4', 'CV_ANALYSIS_PACK'],
          ARRAY['INTERVIEW_1', 'INTERVIEW_PACK']
        ] LOOP
          legacy_code := mapping[1];
          stable_code := mapping[2];
          legacy_package_id := NULL;
          stable_package_id := NULL;

          IF EXISTS (SELECT 1 FROM public.billing_plans WHERE code = legacy_code)
             AND NOT EXISTS (SELECT 1 FROM public.billing_plans WHERE code = stable_code) THEN
            INSERT INTO public.billing_plans
              (code, name, description, category, interval, price_vnd, currency, is_active,
               sort_order, metadata, created_at, updated_at)
            SELECT stable_code, name, description, category, interval, price_vnd, currency,
                   is_active, sort_order, metadata, created_at, now()
            FROM public.billing_plans
            WHERE code = legacy_code;

            SELECT id INTO legacy_package_id
            FROM public.billing_credit_packages
            WHERE plan_code = legacy_code;

            INSERT INTO public.billing_credit_packages (plan_code, credit_type, units)
            SELECT stable_code, credit_type, units
            FROM public.billing_credit_packages
            WHERE plan_code = legacy_code
            RETURNING id INTO stable_package_id;

            UPDATE public.payment_orders
            SET plan_code = stable_code,
                target_id = CASE
                  WHEN target_type = 'CREDIT_PACKAGE' AND target_id = legacy_package_id
                    THEN stable_package_id
                  ELSE target_id
                END
            WHERE plan_code = legacy_code OR target_id = legacy_package_id;

            DELETE FROM public.billing_credit_packages WHERE plan_code = legacy_code;
            DELETE FROM public.billing_plans WHERE code = legacy_code;
          END IF;
        END LOOP;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Keep stable package codes when rolling back this compatibility-only migration.
  }
}
