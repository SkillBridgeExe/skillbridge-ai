import { MigrationInterface, QueryRunner } from 'typeorm';

export class PayosRevenueVerification1786000100000 implements MigrationInterface {
  name = 'PayosRevenueVerification1786000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        ADD COLUMN IF NOT EXISTS provider_verification_status varchar,
        ADD COLUMN IF NOT EXISTS provider_verified_at timestamptz;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_orders_provider_verification
      ON public.payment_orders (provider, provider_verification_status);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_payment_orders_provider_verification;`,
    );
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        DROP COLUMN IF EXISTS provider_verification_status,
        DROP COLUMN IF EXISTS provider_verified_at;
    `);
  }
}
