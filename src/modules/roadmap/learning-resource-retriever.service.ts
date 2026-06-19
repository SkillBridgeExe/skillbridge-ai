import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toSql } from 'pgvector';
import { DatabaseService } from '../../infrastructure/database/database.service';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { rrfFuse } from '../jobs/reco/rrf';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';
import {
  RetrievedResource,
  bm25Search,
  buildResourceSourceText,
  resolveResources,
  selectEmbeddableResources,
} from './resource-embedding';

interface EmbeddingTuple {
  model: string;
  dimensions: number;
  embeddingVersion: string;
}

// Exact-scan cosine over resource_embeddings, geometry-tuple-pinned (mirrors PgVectorService.nearestSkill).
const DENSE_SQL = `
  SELECT resource_id, 1 - (embedding <=> $1::extensions.vector) AS similarity
    FROM public.resource_embeddings
   WHERE model = $2 AND dimensions = $3 AND embedding_version = $4
   ORDER BY embedding <=> $1::extensions.vector
   LIMIT $5`;

/**
 * Hybrid semantic retrieval over the learning catalog — the standard production RAG retriever:
 *   dense (resource_embeddings cosine)  ⊕  sparse (in-memory BM25)  → RRF (k=60, the job-rec combiner).
 * Dense catches paraphrase/semantics; sparse catches exact terms (skill names, tech keywords) that dense
 * underweights — fused they recover ~15-30% more recall than either alone. Verified-only metadata resolve.
 * NO cross-encoder reranker: a curated ~100-doc catalog has high first-stage precision, so a reranker adds
 * latency with no gain. Degrades to sparse-only if the dense index is unavailable (e.g. backfill not run).
 */
@Injectable()
export class LearningResourceRetriever {
  private readonly logger = new Logger(LearningResourceRetriever.name);

  constructor(
    private readonly llm: LlmService,
    private readonly db: DatabaseService,
    private readonly matcher: LearningResourceMatcherService,
    private readonly config: ConfigService,
  ) {}

  private embeddingTuple(): EmbeddingTuple {
    return {
      model: this.config.get<string>('llm.openai.modelEmbedding') ?? 'text-embedding-3-large',
      dimensions: this.config.get<number>('vector.dimension') ?? 1024,
      embeddingVersion: this.config.get<string>('vector.embeddingVersion') ?? 'v1',
    };
  }

  async nearest(input: {
    query: string;
    language?: string;
    topK?: number;
    poolSize?: number;
  }): Promise<RetrievedResource[]> {
    const pool = input.poolSize ?? 20;
    const catalog = this.matcher.allResources();
    const corpus = selectEmbeddableResources(catalog).map((r) => ({
      id: r.id,
      text: buildResourceSourceText(r),
    }));

    const sparseRanks = bm25Search(input.query, corpus, pool);
    const denseRanks = await this.denseSearch(input.query, pool);

    // RRF: rank-only fusion (no score normalization across cosine vs BM25). Deterministic id tiebreak.
    const fused = rrfFuse([denseRanks, sparseRanks]);
    const rankedIds = [...fused.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([id]) => id);

    return resolveResources(rankedIds, catalog, {
      language: input.language,
      topK: input.topK ?? 6,
    });
  }

  /** Dense lane: embed the query → tuple-pinned cosine over resource_embeddings. Degrades to [] on failure. */
  private async denseSearch(query: string, limit: number): Promise<string[]> {
    const tuple = this.embeddingTuple();
    try {
      const embedded = await this.llm.embed(query, { dimensions: tuple.dimensions });
      const rows = await this.db.query<{ resource_id: string }>(DENSE_SQL, [
        toSql(embedded.embedding),
        tuple.model,
        tuple.dimensions,
        tuple.embeddingVersion,
        limit,
      ]);
      return rows.map((r) => r.resource_id);
    } catch (err) {
      this.logger.debug(`dense lane degraded (sparse-only): ${(err as Error).message}`);
      return [];
    }
  }
}
