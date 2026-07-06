import { MigrationInterface, QueryRunner } from 'typeorm';

export class MentorAvailabilityTemplates1781090000000 implements MigrationInterface {
  name = 'MentorAvailabilityTemplates1781090000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.mentor_availability_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mentor_profile_id uuid NOT NULL REFERENCES public.mentor_profiles(id) ON DELETE CASCADE,
        day_of_week integer NOT NULL,
        start_minute integer NOT NULL,
        end_minute integer NOT NULL,
        buffer_minutes integer NOT NULL DEFAULT 0,
        timezone varchar NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_mentor_availability_template_day CHECK (day_of_week BETWEEN 1 AND 7),
        CONSTRAINT chk_mentor_availability_template_minutes CHECK (
          start_minute >= 0
          AND start_minute < 1440
          AND end_minute > start_minute
          AND end_minute <= 1440
        ),
        CONSTRAINT chk_mentor_availability_template_buffer CHECK (buffer_minutes IN (0, 15, 30))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_availability_templates_profile_day ON public.mentor_availability_templates (mentor_profile_id, day_of_week, start_minute);`,
    );

    await queryRunner.query(`
      ALTER TABLE public.mentor_availability_slots
        ADD COLUMN IF NOT EXISTS source varchar NOT NULL DEFAULT 'MANUAL',
        ADD COLUMN IF NOT EXISTS availability_template_id uuid;
    `);
    await queryRunner.query(`
      ALTER TABLE public.mentor_availability_slots
        DROP CONSTRAINT IF EXISTS chk_mentor_slots_source,
        ADD CONSTRAINT chk_mentor_slots_source CHECK (source IN ('MANUAL', 'TEMPLATE'));
    `);
    await queryRunner.query(`
      ALTER TABLE public.mentor_availability_slots
        DROP CONSTRAINT IF EXISTS fk_mentor_slots_template,
        ADD CONSTRAINT fk_mentor_slots_template
          FOREIGN KEY (availability_template_id)
          REFERENCES public.mentor_availability_templates(id)
          ON DELETE SET NULL;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mentor_slots_template ON public.mentor_availability_slots (availability_template_id);`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_mentor_template_slot_time ON public.mentor_availability_slots (availability_template_id, starts_at, ends_at) WHERE source = 'TEMPLATE' AND availability_template_id IS NOT NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.uq_mentor_template_slot_time;`);
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_mentor_slots_template;`);
    await queryRunner.query(`
      ALTER TABLE public.mentor_availability_slots
        DROP CONSTRAINT IF EXISTS fk_mentor_slots_template,
        DROP CONSTRAINT IF EXISTS chk_mentor_slots_source,
        DROP COLUMN IF EXISTS availability_template_id,
        DROP COLUMN IF EXISTS source;
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_mentor_availability_templates_profile_day;`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS public.mentor_availability_templates;`);
  }
}
