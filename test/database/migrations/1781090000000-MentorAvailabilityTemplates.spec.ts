import { QueryRunner } from 'typeorm';
import { MentorAvailabilityTemplates1781090000000 } from '../../../src/database/migrations/1781090000000-MentorAvailabilityTemplates';

describe('MentorAvailabilityTemplates1781090000000', () => {
  it('creates weekly availability templates and generated slot metadata', async () => {
    const queries = await collectUpQueries();
    const sql = queries.join('\n');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.mentor_availability_templates');
    expect(sql).toContain('day_of_week integer NOT NULL');
    expect(sql).toContain('start_minute integer NOT NULL');
    expect(sql).toContain('end_minute integer NOT NULL');
    expect(sql).toContain('buffer_minutes integer NOT NULL DEFAULT 0');
    expect(sql).toContain("timezone varchar NOT NULL DEFAULT 'Asia/Ho_Chi_Minh'");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source varchar NOT NULL DEFAULT 'MANUAL'");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS availability_template_id uuid');
  });

  it('reverts weekly templates and generated slot metadata', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    await new MentorAvailabilityTemplates1781090000000().down(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain('DROP TABLE IF EXISTS public.mentor_availability_templates;');
    expect(sql).toContain('DROP COLUMN IF EXISTS availability_template_id');
    expect(sql).toContain('DROP COLUMN IF EXISTS source');
  });
});

async function collectUpQueries(): Promise<string[]> {
  const queries: string[] = [];
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;

  await new MentorAvailabilityTemplates1781090000000().up(queryRunner);

  return queries;
}
