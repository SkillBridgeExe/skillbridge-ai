import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds chat_conversations.cv_id so the CV-diagnosis advisor can run on a CV-only scan (no JD match).
 * CV-only chats are keyed by (user_id, cv_id) with match_id NULL; a JD chat for the SAME cv stays keyed
 * by its match_id, so the two threads never collide on the existing (user_id, match_id=NULL) key.
 * FK → cvs(id) ON DELETE SET NULL (the thread survives a CV soft/hard delete, like the match FK).
 */
export class ChatConversationCvId1780740000000 implements MigrationInterface {
  name = 'ChatConversationCvId1780740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.chat_conversations
      ADD COLUMN IF NOT EXISTS cv_id uuid NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE public.chat_conversations
      ADD CONSTRAINT fk_chat_conversations_cv
        FOREIGN KEY (cv_id) REFERENCES public.cvs(id) ON DELETE SET NULL;
    `);
    // Partial index for the CV-only resolve path: findOne({ user_id, cv_id, match_id IS NULL }).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_cv
      ON public.chat_conversations (user_id, cv_id)
      WHERE cv_id IS NOT NULL AND match_id IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_chat_conversations_user_cv;`);
    await queryRunner.query(`
      ALTER TABLE public.chat_conversations
      DROP CONSTRAINT IF EXISTS fk_chat_conversations_cv;
    `);
    await queryRunner.query(`
      ALTER TABLE public.chat_conversations
      DROP COLUMN IF EXISTS cv_id;
    `);
  }
}
