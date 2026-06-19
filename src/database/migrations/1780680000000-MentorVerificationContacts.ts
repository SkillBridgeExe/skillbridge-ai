import { MigrationInterface, QueryRunner } from 'typeorm';

export class MentorVerificationContacts1780680000000 implements MigrationInterface {
  name = 'MentorVerificationContacts1780680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.mentor_profiles ADD COLUMN IF NOT EXISTS linkedin_url text;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.mentor_profiles ADD COLUMN IF NOT EXISTS phone_number varchar(32);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.mentor_profiles DROP COLUMN IF EXISTS phone_number;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.mentor_profiles DROP COLUMN IF EXISTS linkedin_url;`,
    );
  }
}
