import { MigrationInterface, QueryRunner } from 'typeorm';

export class InterviewQuestionBank1780730000000 implements MigrationInterface {
  name = 'InterviewQuestionBank1780730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.interview_question_bank_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        question_key varchar NOT NULL,
        language varchar NOT NULL,
        target_role varchar NOT NULL,
        interview_type varchar NOT NULL,
        phase varchar NOT NULL,
        skill_canonical varchar,
        focus_type varchar,
        seniority varchar,
        difficulty integer NOT NULL,
        question_text text NOT NULL,
        expected_signals jsonb NOT NULL,
        rubric_dimensions jsonb NOT NULL,
        source_kind varchar NOT NULL,
        source_url text,
        source_basis text NOT NULL,
        license varchar NOT NULL,
        attribution text,
        review_status varchar NOT NULL,
        priority integer NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz,
        CONSTRAINT chk_interview_question_bank_language CHECK (language IN ('vi', 'en')),
        CONSTRAINT chk_interview_question_bank_type CHECK (
          interview_type IN ('HR', 'TECHNICAL', 'MIXED')
        ),
        CONSTRAINT chk_interview_question_bank_phase CHECK (
          phase IN ('SCREENING', 'SKILL_PROBE', 'JD_REQUIREMENT', 'SCENARIO', 'BEHAVIORAL', 'WRAP')
        ),
        CONSTRAINT chk_interview_question_bank_focus_type CHECK (
          focus_type IS NULL OR focus_type IN (
            'gap_probe',
            'depth_probe',
            'evidence_probe',
            'strength_showcase'
          )
        ),
        CONSTRAINT chk_interview_question_bank_difficulty CHECK (difficulty BETWEEN 1 AND 5),
        CONSTRAINT chk_interview_question_bank_review_status CHECK (
          review_status IN ('draft', 'mentor_reviewed', 'disabled')
        )
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_interview_question_bank_key_language
      ON public.interview_question_bank_items (question_key, language);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_interview_question_bank_lookup
      ON public.interview_question_bank_items (
        active,
        language,
        target_role,
        interview_type,
        phase,
        skill_canonical
      );
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_turns
      ADD COLUMN IF NOT EXISTS question_bank_item_id uuid,
      ADD COLUMN IF NOT EXISTS question_bank_key varchar;
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_turns
      DROP CONSTRAINT IF EXISTS fk_interview_turns_question_bank_item;
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_turns
      ADD CONSTRAINT fk_interview_turns_question_bank_item
      FOREIGN KEY (question_bank_item_id)
      REFERENCES public.interview_question_bank_items(id)
      ON DELETE SET NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_interview_turns_question_bank_item
      ON public.interview_turns (question_bank_item_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_interview_turns_question_bank_item;`);
    await queryRunner.query(`
      ALTER TABLE public.interview_turns
      DROP CONSTRAINT IF EXISTS fk_interview_turns_question_bank_item;
    `);
    await queryRunner.query(`
      ALTER TABLE public.interview_turns
      DROP COLUMN IF EXISTS question_bank_item_id,
      DROP COLUMN IF EXISTS question_bank_key;
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_interview_question_bank_lookup;`);
    await queryRunner.query(`DROP INDEX IF EXISTS public.uq_interview_question_bank_key_language;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.interview_question_bank_items;`);
  }
}
