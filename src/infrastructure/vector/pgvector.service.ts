import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toSql } from 'pgvector';
import { DatabaseService } from '../database/database.service';

export interface VectorSearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: Record<string, unknown> | null;
}

/** Identity tuple of an embedding space — vectors across tuples are geometrically incompatible. */
export interface EmbeddingTuple {
  model: string;
  dimensions: number;
  embeddingVersion: string;
}

export interface NearestSkillResult {
  /** skills.id (uuid) of the top-1 neighbor. */
  skillId: string;
  /** canonical_name of that skill (joined for the normalizer — no second roundtrip). */
  canonicalName: string;
  /** Which embedded surface form won (canonical | display | alias text). */
  sourceText: string;
  /** Cosine similarity in [-1, 1] (1 − cosine distance). */
  similarity: number;
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

  /**
   * Top-1 cosine neighbor in `skill_embeddings`, filtered on the FULL embedding-identity tuple
   * (model + dimensions + embedding_version) — mixing tuples in one query is meaningless
   * geometry, so the filter is mandatory, not an optimization.
   *
   * Exact scan by design: at ~750 rows there is NO vector index (perfect recall, faster than
   * ANN at this scale — pgvector guidance). The vector type lives in the `extensions` schema
   * (Supabase convention), hence the schema-qualified cast.
   *
   * Returns null when the table has no rows for the tuple (e.g. backfill not run yet).
   * DB errors propagate — the caller (SemanticSkillMatcherService) degrades gracefully.
   */
  async nearestSkill(
    queryEmbedding: number[],
    tuple: EmbeddingTuple,
  ): Promise<NearestSkillResult | null> {
    this.assertDimension(queryEmbedding);

    const rows = await this.db.query<{
      skill_id: string;
      canonical_name: string;
      source_text: string;
      similarity: number;
    }>(
      `SELECT e.skill_id,
              s.canonical_name,
              e.source_text,
              1 - (e.embedding <=> $1::extensions.vector) AS similarity
         FROM public.skill_embeddings e
         JOIN public.skills s ON s.id = e.skill_id
        WHERE e.model = $2
          AND e.dimensions = $3
          AND e.embedding_version = $4
        ORDER BY e.embedding <=> $1::extensions.vector
        LIMIT 1`,
      [toSql(queryEmbedding), tuple.model, tuple.dimensions, tuple.embeddingVersion],
    );

    const row = rows[0];
    if (!row) return null;
    return {
      skillId: row.skill_id,
      canonicalName: row.canonical_name,
      sourceText: row.source_text,
      similarity: Number(row.similarity),
    };
  }

  private assertDimension(vec: number[]): void {
    if (vec.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${vec.length}`);
    }
  }
}
