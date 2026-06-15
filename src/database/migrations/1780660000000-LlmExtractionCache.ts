import { MigrationInterface, QueryRunner } from 'typeorm';

export class LlmExtractionCache1780660000000 implements MigrationInterface {
  name = 'LlmExtractionCache1780660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_extraction_cache" (
        "cache_key" varchar(64) PRIMARY KEY,
        "payload" jsonb NOT NULL,
        "provider" varchar(32) NOT NULL,
        "model_code" varchar(128) NOT NULL,
        "template_code" varchar(128) NOT NULL,
        "prompt_template_version" integer NOT NULL,
        "hit_count" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_hit_at" timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_extraction_cache_template_model"
      ON "llm_extraction_cache" ("template_code", "model_code")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "idx_llm_extraction_cache_template_model"');
    await queryRunner.query('DROP TABLE IF EXISTS "llm_extraction_cache"');
  }
}
