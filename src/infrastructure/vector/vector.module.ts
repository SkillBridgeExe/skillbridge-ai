import { Global, Module } from '@nestjs/common';
import { PgVectorService } from './pgvector.service';

/**
 * Vector store abstraction (currently backed by pgvector in the main Postgres).
 *
 * Used for:
 *   - Embedding CV / JD / course chunks into document_chunks.embedding
 *   - Cosine-similarity retrieval for RAG
 */
@Global()
@Module({
  providers: [PgVectorService],
  exports: [PgVectorService],
})
export class VectorModule {}
