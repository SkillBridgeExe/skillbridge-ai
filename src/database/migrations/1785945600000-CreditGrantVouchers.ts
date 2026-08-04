import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreditGrantVouchers1785945600000 implements MigrationInterface {
  name = 'CreditGrantVouchers1785945600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.vouchers
        ADD COLUMN benefit_type varchar,
        ADD COLUMN credit_type varchar,
        ADD COLUMN credit_units integer,
        ALTER COLUMN discount_percent DROP NOT NULL,
        ALTER COLUMN applicable_plan_code DROP NOT NULL,
        DROP CONSTRAINT chk_vouchers_discount,
        DROP CONSTRAINT chk_vouchers_premium_only;
    `);
    await queryRunner.query(`
      UPDATE public.vouchers
      SET benefit_type = 'PERCENT_DISCOUNT'
      WHERE benefit_type IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE public.vouchers
        ALTER COLUMN benefit_type SET DEFAULT 'PERCENT_DISCOUNT',
        ALTER COLUMN benefit_type SET NOT NULL,
        ADD CONSTRAINT chk_vouchers_reward CHECK (
          (
            benefit_type = 'PERCENT_DISCOUNT'
            AND discount_percent BETWEEN 1 AND 99
            AND applicable_plan_code = 'PREMIUM'
            AND credit_type IS NULL
            AND credit_units IS NULL
          )
          OR
          (
            benefit_type = 'CREDIT_GRANT'
            AND discount_percent IS NULL
            AND applicable_plan_code IS NULL
            AND credit_type IN ('CV_ANALYSIS', 'INTERVIEW_SESSION')
            AND credit_units > 0
          )
        );
    `);

    await queryRunner.query(`
      ALTER TABLE public.voucher_redemptions
        ALTER COLUMN reserved_until DROP NOT NULL,
        DROP CONSTRAINT chk_voucher_redemptions_redeemed_at,
        ADD CONSTRAINT chk_voucher_redemptions_state CHECK (
          (
            status = 'RESERVED'
            AND reserved_until IS NOT NULL
            AND redeemed_at IS NULL
          )
          OR
          (
            status = 'REDEEMED'
            AND redeemed_at IS NOT NULL
          )
          OR
          (
            status = 'RELEASED'
            AND redeemed_at IS NULL
          )
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM public.voucher_redemptions redemption
          INNER JOIN public.vouchers voucher ON voucher.id = redemption.voucher_id
          WHERE voucher.benefit_type = 'CREDIT_GRANT'
        ) THEN
          RAISE EXCEPTION 'Cannot revert credit vouchers after a redemption has been recorded';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DELETE FROM public.vouchers
      WHERE benefit_type = 'CREDIT_GRANT';
    `);
    await queryRunner.query(`
      ALTER TABLE public.voucher_redemptions
        DROP CONSTRAINT chk_voucher_redemptions_state,
        ALTER COLUMN reserved_until SET NOT NULL,
        ADD CONSTRAINT chk_voucher_redemptions_redeemed_at CHECK (
          (status = 'REDEEMED' AND redeemed_at IS NOT NULL)
          OR (status <> 'REDEEMED' AND redeemed_at IS NULL)
        );
    `);
    await queryRunner.query(`
      ALTER TABLE public.vouchers
        DROP CONSTRAINT chk_vouchers_reward,
        ALTER COLUMN discount_percent SET NOT NULL,
        ALTER COLUMN applicable_plan_code SET NOT NULL,
        DROP COLUMN credit_units,
        DROP COLUMN credit_type,
        DROP COLUMN benefit_type,
        ADD CONSTRAINT chk_vouchers_discount CHECK (discount_percent BETWEEN 1 AND 99),
        ADD CONSTRAINT chk_vouchers_premium_only CHECK (applicable_plan_code = 'PREMIUM');
    `);
  }
}
