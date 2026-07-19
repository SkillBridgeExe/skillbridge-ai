import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Discriminates chat_conversations threads that share the same (user_id, cv_id) key.
 *
 * A CV-only diagnosis chat is keyed {userId, cvId, matchId: NULL}. A CV-builder chat thread
 * (Task 1.7) would be keyed identically and collide without this column. Every existing row
 * is a diagnosis thread, so the default backfills them correctly.
 */
export class AddChatConversationPurpose1781240000000 implements MigrationInterface {
  name = 'AddChatConversationPurpose1781240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE chat_conversations ADD COLUMN purpose varchar(32) NOT NULL DEFAULT 'diagnosis';`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE chat_conversations DROP COLUMN purpose;`);
  }
}
