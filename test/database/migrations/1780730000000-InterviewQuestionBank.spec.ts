import { QueryRunner } from 'typeorm';
import { InterviewQuestionBank1780730000000 } from '../../../src/database/migrations/1780730000000-InterviewQuestionBank';

describe('InterviewQuestionBank1780730000000', () => {
  it('creates the interview question bank table and turn tracking columns', async () => {
    const sql = (await collectUpQueries()).join('\n');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.interview_question_bank_items');
    for (const column of [
      'question_key varchar NOT NULL',
      'language varchar NOT NULL',
      'target_role varchar NOT NULL',
      'interview_type varchar NOT NULL',
      'phase varchar NOT NULL',
      'skill_canonical varchar',
      'focus_type varchar',
      'seniority varchar',
      'difficulty integer NOT NULL',
      'question_text text NOT NULL',
      'expected_signals jsonb NOT NULL',
      'rubric_dimensions jsonb NOT NULL',
      'source_kind varchar NOT NULL',
      'source_url text',
      'source_basis text NOT NULL',
      'license varchar NOT NULL',
      'attribution text',
      'review_status varchar NOT NULL',
      'priority integer NOT NULL',
      'active boolean NOT NULL',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('uq_interview_question_bank_key_language');
    expect(sql).toContain('idx_interview_question_bank_lookup');
    expect(sql).toContain('question_bank_item_id uuid');
    expect(sql).toContain('question_bank_key varchar');
    expect(sql).toContain('fk_interview_turns_question_bank_item');
  });

  it('drops turn tracking columns before dropping the bank table', async () => {
    const sql = (await collectDownQueries()).join('\n');

    expect(sql.indexOf('DROP COLUMN IF EXISTS question_bank_item_id')).toBeGreaterThanOrEqual(0);
    expect(
      sql.indexOf('DROP TABLE IF EXISTS public.interview_question_bank_items'),
    ).toBeGreaterThan(sql.indexOf('DROP COLUMN IF EXISTS question_bank_item_id'));
  });
});

async function collectUpQueries(): Promise<string[]> {
  const queries: string[] = [];
  const runner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;
  await new InterviewQuestionBank1780730000000().up(runner);
  return queries;
}

async function collectDownQueries(): Promise<string[]> {
  const queries: string[] = [];
  const runner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;
  await new InterviewQuestionBank1780730000000().down(runner);
  return queries;
}
