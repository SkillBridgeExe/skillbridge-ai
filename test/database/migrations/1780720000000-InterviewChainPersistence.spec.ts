import { QueryRunner } from 'typeorm';
import { InterviewChainPersistence1780720000000 } from '../../../src/database/migrations/1780720000000-InterviewChainPersistence';

describe('InterviewChainPersistence1780720000000', () => {
  it('adds the session and turn json/state columns required by the new interview chain', async () => {
    const queries = await collectUpQueries();
    const sql = queries.join('\n');

    for (const column of [
      'agenda jsonb',
      'interview_state jsonb',
      'final_score jsonb',
      'gap_items jsonb',
      'dev_plan jsonb',
      'coaching jsonb',
      'topic_phase varchar',
      'depth_signal varchar',
      'signals jsonb',
      'insight jsonb',
      'current_thread text',
      'skill_canonical varchar',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it('drops the new columns in reverse-compatible down migration', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    await new InterviewChainPersistence1780720000000().down(queryRunner);
    const sql = queries.join('\n');

    for (const column of [
      'coaching',
      'dev_plan',
      'gap_items',
      'final_score',
      'interview_state',
      'agenda',
      'skill_canonical',
      'current_thread',
      'insight',
      'signals',
      'depth_signal',
      'topic_phase',
    ]) {
      expect(sql).toContain(`DROP COLUMN IF EXISTS ${column}`);
    }
  });
});

async function collectUpQueries(): Promise<string[]> {
  const queries: string[] = [];
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;

  await new InterviewChainPersistence1780720000000().up(queryRunner);

  return queries;
}
