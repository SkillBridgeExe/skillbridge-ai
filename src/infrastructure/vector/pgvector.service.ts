import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

export interface VectorSearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: Record<string, unknown> | null;
}

/**
 * pgvector wrapper.
 *
 * Assumes the schema has:
 *   document_chunks(id, document_id, chunk_index, content, embedding vector(N), metadata)
 * with an ivfflat or hnsw index on `embedding`.
 *
 * TODO: hook into DatabaseService once .NET runs the initial migration.
 */
@Injectable()
export class PgVectorService {
  private readonly logger = new Logger(PgVectorService.name);
  private readonly table: string;
  private readonly column: string;
  private readonly dimension: number;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {
    this.table = this.config.get<string>('vector.table') ?? 'document_chunks';
    this.column = this.config.get<string>('vector.column') ?? 'embedding';
    this.dimension = this.config.get<number>('vector.dimension') ?? 768;
  }

  /**
   * Inserts an embedding vector for a chunk row that already exists.
   * Returns the chunk row id.
   *
   * Stub: real implementation will format the vector literal and UPDATE.
   */
  async upsertChunkEmbedding(chunkId: string, embedding: number[]): Promise<string> {
    this.assertDimension(embedding);
    this.logger.debug(`[stub] upsertChunkEmbedding chunkId=${chunkId} dim=${embedding.length}`);
    // TODO: UPDATE document_chunks SET embedding = $1::vector WHERE id = $2
    return chunkId;
  }

  /**
   * Cosine similarity search.
   * Stub: real implementation runs:
   *   SELECT id, document_id, content, metadata,
   *          1 - (embedding <=> $1::vector) AS score
   *   FROM document_chunks
   *   WHERE <filters>
   *   ORDER BY embedding <=> $1::vector
   *   LIMIT $k
   */
  async search(
    queryEmbedding: number[],
    options: { topK: number; filter?: Record<string, unknown> } = { topK: 5 },
  ): Promise<VectorSearchResult[]> {
    this.assertDimension(queryEmbedding);
    this.logger.debug(`[stub] vector search topK=${options.topK}`);
    return [];
  }

  private assertDimension(vec: number[]): void {
    if (vec.length !== this.dimension) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimension}, got ${vec.length}`,
      );
    }
  }
}
