/**
 * One-shot backfill for public.resource_embeddings.
 *
 * Reads the unified learning resource catalog, embeds curated metadata only, and upserts rows pinned
 * to (resource_id, model, dimensions, embedding_version). Pending resources are embedded too so a later
 * pending->verified flip does not require re-spend; dead links are skipped.
 */
import OpenAI from 'openai';
import { Pool } from 'pg';
import { toSql } from 'pgvector';
import { LearningResourceMatcherService } from '../modules/roadmap/learning-resource-matcher.service';
import { LearningResource } from '../modules/roadmap/learning-resource';
import {
  buildResourceSourceText,
  selectEmbeddableResources,
} from '../modules/roadmap/resource-embedding';
import { embedBatch } from './embedding-shared';

export interface ResourceEmbeddingRow {
  resource_id: string;
  source_text: string;
  embedding: number[];
  model: string;
  dimensions: number;
  embedding_version: string;
}

export function selectResourceEmbeddingTodo(
  catalog: LearningResource[],
  existingResourceIds: Set<string>,
): LearningResource[] {
  return selectEmbeddableResources(catalog).filter((r) => !existingResourceIds.has(r.id));
}

export function buildResourceEmbeddingRows(
  resources: LearningResource[],
  vectors: number[][],
  model: string,
  dimensions: number,
  embeddingVersion: string,
): ResourceEmbeddingRow[] {
  if (resources.length !== vectors.length) {
    throw new Error(`Expected ${resources.length} vectors, got ${vectors.length}`);
  }
  return resources.map((resource, i) => ({
    resource_id: resource.id,
    source_text: buildResourceSourceText(resource),
    embedding: vectors[i],
    model,
    dimensions,
    embedding_version: embeddingVersion,
  }));
}

async function main(): Promise<void> {
  const dotenv = await import('dotenv');
  const dotenvParsed = dotenv.config().parsed ?? {};
  if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

  const apiKey = process.env.OPENAI_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const model = process.env.OPENAI_MODEL_EMBEDDING ?? 'text-embedding-3-large';
  const dimensions = parseInt(process.env.VECTOR_DIMENSION ?? '1024', 10);
  const embeddingVersion = process.env.VECTOR_EMBEDDING_VERSION ?? 'v1';

  const COLUMN_VECTOR_WIDTH = 1024;
  if (dimensions !== COLUMN_VECTOR_WIDTH) {
    throw new Error(
      `VECTOR_DIMENSION=${dimensions} but resource_embeddings.embedding is vector(${COLUMN_VECTOR_WIDTH}).`,
    );
  }

  const matcher = new LearningResourceMatcherService();
  matcher.onModuleInit();
  const catalog = matcher.allResources();
  if (catalog.length === 0) throw new Error('Learning resource catalog is empty');

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const existingRows = await pool.query<{ resource_id: string }>(
      `SELECT resource_id FROM public.resource_embeddings
        WHERE model = $1 AND dimensions = $2 AND embedding_version = $3`,
      [model, dimensions, embeddingVersion],
    );
    const existing = new Set(existingRows.rows.map((r) => r.resource_id));
    const todo = selectResourceEmbeddingTodo(catalog, existing);

    console.log(
      `Resources: ${catalog.length} catalog rows, ${existing.size} embedded for tuple, ${todo.length} to embed.`,
    );
    if (todo.length === 0) {
      console.log('Nothing to do - resource embedding matrix is complete for this tuple.');
      return;
    }

    const client = new OpenAI({ apiKey, maxRetries: 5, timeout: 60_000 });
    const texts = todo.map(buildResourceSourceText);
    const { vectors, totalTokens } = await embedBatch(client, texts, model, dimensions);
    const rows = buildResourceEmbeddingRows(todo, vectors, model, dimensions, embeddingVersion);

    let inserted = 0;
    const ROWS_PER_STMT = 100;
    for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
      const slice = rows.slice(i, i + ROWS_PER_STMT);
      const params: unknown[] = [];
      const tuples = slice.map((row, j) => {
        const base = j * 6;
        params.push(
          row.resource_id,
          toSql(row.embedding),
          row.source_text,
          row.model,
          row.dimensions,
          row.embedding_version,
        );
        return `($${base + 1}, $${base + 2}::extensions.vector, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      });
      const result = await pool.query(
        `INSERT INTO public.resource_embeddings
           (resource_id, embedding, source_text, model, dimensions, embedding_version)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (resource_id, model, dimensions, embedding_version) DO NOTHING`,
        params,
      );
      inserted += result.rowCount ?? 0;
    }

    const estCost = (totalTokens / 1_000_000) * 0.13;
    console.log(
      `Done: inserted ${inserted}/${todo.length} rows - ${totalTokens} tokens - est $${estCost.toFixed(4)}`,
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`backfill failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
