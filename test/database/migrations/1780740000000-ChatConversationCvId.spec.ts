import { QueryRunner } from 'typeorm';
import { ChatConversationCvId1780740000000 } from '../../../src/database/migrations/1780740000000-ChatConversationCvId';

describe('ChatConversationCvId1780740000000', () => {
  it('adds the cv_id column + FK + partial index needed for the CV-only diagnosis chat', async () => {
    const sql = (await collectQueries((m) => m.up.bind(m))).join('\n');

    expect(sql).toContain('ALTER TABLE public.chat_conversations');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS cv_id uuid');
    expect(sql).toContain('fk_chat_conversations_cv');
    expect(sql).toContain('REFERENCES public.cvs(id) ON DELETE SET NULL');
    expect(sql).toContain('idx_chat_conversations_user_cv');
  });

  it('drops the column, FK and index in the down migration', async () => {
    const sql = (await collectQueries((m) => m.down.bind(m))).join('\n');

    expect(sql).toContain('DROP INDEX IF EXISTS public.idx_chat_conversations_user_cv');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS fk_chat_conversations_cv');
    expect(sql).toContain('DROP COLUMN IF EXISTS cv_id');
  });
});

async function collectQueries(
  pick: (m: ChatConversationCvId1780740000000) => (qr: QueryRunner) => Promise<void>,
): Promise<string[]> {
  const queries: string[] = [];
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;

  await pick(new ChatConversationCvId1780740000000())(queryRunner);

  return queries;
}
