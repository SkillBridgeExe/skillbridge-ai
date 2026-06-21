import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * resource_embeddings — dense vector store for the learning-resource catalog (the dense half of the
 * hybrid RAG retriever). Mirrors job_embeddings exactly: vector(1024), geometry-tuple-pinned UNIQUE,
 * NO ANN index (a few hundred curated rows → exact scan is faster + perfect recall, pgvector guidance).
 */
export class ResourceEmbeddings1780690000000 implements MigrationInterface {
  name = 'ResourceEmbeddings1780690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.resource_embeddings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        resource_id varchar(64) NOT NULL,
        embedding extensions.vector(1024) NOT NULL,
        source_text text NOT NULL,
        model varchar(64) NOT NULL,
        dimensions int NOT NULL,
        embedding_version varchar(16) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_resource_embeddings UNIQUE (resource_id, model, dimensions, embedding_version)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_resource_embeddings_resource ON public.resource_embeddings (resource_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_resource_embeddings_tuple ON public.resource_embeddings (model, dimensions, embedding_version);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.resource_embeddings;`);
  }
}
