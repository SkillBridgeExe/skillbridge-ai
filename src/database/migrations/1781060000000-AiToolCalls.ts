import { MigrationInterface, QueryRunner } from 'typeorm';

export class AiToolCalls1781060000000 implements MigrationInterface {
  name = 'AiToolCalls1781060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_tool_calls" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ai_request_id" uuid,
        "user_id" uuid,
        "tool_name" character varying NOT NULL,
        "args_hash" character varying(64) NOT NULL,
        "status" character varying NOT NULL,
        "latency_ms" integer,
        "error_message" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_tool_calls_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_tool_calls_ai_request_id" FOREIGN KEY ("ai_request_id") REFERENCES "ai_requests"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_ai_tool_calls_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_tool_calls_ai_request_id" ON "ai_tool_calls" ("ai_request_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_tool_calls_tool_name" ON "ai_tool_calls" ("tool_name")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_tool_calls_user_tool_created" ON "ai_tool_calls" ("user_id", "tool_name", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_tool_calls_created_at" ON "ai_tool_calls" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_tool_calls" DROP CONSTRAINT IF EXISTS "FK_ai_tool_calls_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai_tool_calls" DROP CONSTRAINT IF EXISTS "FK_ai_tool_calls_ai_request_id"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_tool_calls_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_tool_calls_user_tool_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_tool_calls_tool_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ai_tool_calls_ai_request_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_tool_calls"`);
  }
}
