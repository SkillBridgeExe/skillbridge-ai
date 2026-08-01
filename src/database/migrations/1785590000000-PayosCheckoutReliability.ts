import { MigrationInterface, QueryRunner } from 'typeorm';

export class PayosCheckoutReliability1785590000000 implements MigrationInterface {
  name = 'PayosCheckoutReliability1785590000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        ADD COLUMN return_url text,
        ADD COLUMN cancel_url text,
        ADD COLUMN last_provider_check_at timestamptz;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.payment_orders
        DROP COLUMN IF EXISTS last_provider_check_at,
        DROP COLUMN IF EXISTS cancel_url,
        DROP COLUMN IF EXISTS return_url;
    `);
  }
}
