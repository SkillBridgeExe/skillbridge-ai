import { QueryRunner } from 'typeorm';
import { AiToolCalls1781060000000 } from '../../../src/database/migrations/1781060000000-AiToolCalls';

describe('AiToolCalls1781060000000', () => {
  it('adds a nullable FK from ai_tool_calls.ai_request_id to ai_requests(id)', async () => {
    const sql = (await collectQueries((m) => m.up.bind(m))).join('\n');

    expect(sql).toContain('FK_ai_tool_calls_ai_request_id');
    expect(sql).toContain('FOREIGN KEY ("ai_request_id") REFERENCES "ai_requests"("id")');
    expect(sql).toContain('ON DELETE SET NULL');
  });

  it('drops the FK before dropping ai_tool_calls', async () => {
    const sql = (await collectQueries((m) => m.down.bind(m))).join('\n');

    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "FK_ai_tool_calls_ai_request_id"');
    expect(sql.indexOf('DROP CONSTRAINT')).toBeLessThan(sql.indexOf('DROP TABLE'));
  });
});

async function collectQueries(
  pick: (m: AiToolCalls1781060000000) => (qr: QueryRunner) => Promise<void>,
): Promise<string[]> {
  const queries: string[] = [];
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;

  await pick(new AiToolCalls1781060000000())(queryRunner);

  return queries;
}
