import { MigrationInterface, QueryRunner } from 'typeorm';

export class LearningChatPersistence1780710000000 implements MigrationInterface {
  name = 'LearningChatPersistence1780710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.chat_conversations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        match_id uuid NULL,
        title varchar NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT fk_chat_conversations_user
          FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT fk_chat_conversations_match
          FOREIGN KEY (match_id) REFERENCES public.cv_matches(id) ON DELETE SET NULL
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_created ON public.chat_conversations (user_id, created_at DESC);`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.chat_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL,
        role varchar NOT NULL,
        content text NOT NULL,
        metadata jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_chat_messages_role CHECK (role IN ('user', 'assistant')),
        CONSTRAINT fk_chat_messages_conversation
          FOREIGN KEY (conversation_id) REFERENCES public.chat_conversations(id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created ON public.chat_messages (conversation_id, created_at DESC);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.chat_messages;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.chat_conversations;`);
  }
}
