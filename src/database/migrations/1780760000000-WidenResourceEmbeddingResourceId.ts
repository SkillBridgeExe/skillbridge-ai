import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widen resource_embeddings.resource_id varchar(64) -> varchar(128).
 *
 * The learning catalog grew to 8k+ rows (bulk-seeded video/course resources) whose slug-style ids
 * run up to 89 chars, overflowing the original varchar(64) and silently breaking
 * `embeddings:backfill-resources` (every run aborted on "value too long", so the dense RAG matrix
 * was stuck at the ~180 vectors from when the catalog was small). 128 covers the current max (89)
 * with headroom. Widening is non-destructive; no data migration needed.
 */
export class WidenResourceEmbeddingResourceId1780760000000 implements MigrationInterface {
  name = 'WidenResourceEmbeddingResourceId1780760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.resource_embeddings ALTER COLUMN resource_id TYPE varchar(128);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversible only if no id currently exceeds 64 chars (Postgres rejects the shrink otherwise).
    await queryRunner.query(
      `ALTER TABLE public.resource_embeddings ALTER COLUMN resource_id TYPE varchar(64);`,
    );
  }
}
