/**
 * R2 step 7d — one-shot backfill of `public.skill_embeddings` (the semantic tier's matrix).
 *
 *   pnpm embeddings:backfill
 *
 * Reads data/skills-pilot.json, embeds every distinct skill surface form
 * (canonical + display + aliases, deduped by normalized key — see embedding-shared.ts),
 * and inserts the vectors tagged with the FULL embedding tuple
 * (model, dimensions, embedding_version).
 *
 * Safety properties:
 *   - ABORTS BEFORE SPEND if any taxonomy canonical is missing from public.skills
 *     (run `pnpm seed` first) — no orphan vectors, no wasted tokens.
 *   - Idempotent: re-runs skip source_texts already present for the tuple (zero re-spend),
 *     and inserts use ON CONFLICT DO NOTHING.
 *   - Cost is reported from real usage tokens (text-embedding-3-large ≈ $0.13/1M tokens;
 *     a full 106-skill backfill is well under one cent).
 *
 * Env: OPENAI_API_KEY + DATABASE_URL required; OPENAI_MODEL_EMBEDDING / VECTOR_DIMENSION /
 * VECTOR_EMBEDDING_VERSION default to the production config defaults.
 */
import * as dotenv from 'dotenv';
// SURGICAL override: a stale OS-level OPENAI_API_KEY has shadowed .env before (known Windows
// gotcha) — for a billing-relevant script the .env key is the contract. Only that one var is
// forced; everything else keeps normal precedence (shell/CI overrides still work).
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import OpenAI from 'openai';
import { Pool } from 'pg';
import { toSql } from 'pgvector';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { embedBatch, enumerateSkillVariants } from './embedding-shared';

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const model = process.env.OPENAI_MODEL_EMBEDDING ?? 'text-embedding-3-large';
  const dimensions = parseInt(process.env.VECTOR_DIMENSION ?? '1024', 10);
  const embeddingVersion = process.env.VECTOR_EMBEDDING_VERSION ?? 'v1';

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const entries = taxonomy.getAll();
  if (entries.length === 0) throw new Error('Taxonomy is empty — data/skills-pilot.json missing?');

  const variants = enumerateSkillVariants(entries);
  console.log(
    `Taxonomy: ${entries.length} skills → ${variants.length} distinct surface forms ` +
      `(tuple ${model}/${dimensions}/${embeddingVersion})`,
  );

  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  try {
    // 1. Resolve canonical → skills.id; ABORT before any embedding spend on a partial seed.
    const skillRows = await pool.query<{ id: string; canonical_name: string }>(
      'SELECT id, canonical_name FROM public.skills',
    );
    const idByCanonical = new Map(skillRows.rows.map((r) => [r.canonical_name, r.id]));
    const missing = [...new Set(variants.map((v) => v.canonical))].filter(
      (c) => !idByCanonical.has(c),
    );
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} taxonomy canonicals are missing from public.skills (run \`pnpm seed\` first): ` +
          missing.slice(0, 10).join(', ') +
          (missing.length > 10 ? ', …' : ''),
      );
    }

    // 2. Skip texts already embedded for this tuple (idempotent re-run, zero re-spend).
    const existingRows = await pool.query<{ source_text: string }>(
      `SELECT source_text FROM public.skill_embeddings
        WHERE model = $1 AND dimensions = $2 AND embedding_version = $3`,
      [model, dimensions, embeddingVersion],
    );
    const existing = new Set(existingRows.rows.map((r) => r.source_text));
    const todo = variants.filter((v) => !existing.has(v.text));
    console.log(`Already embedded: ${existing.size} · to embed now: ${todo.length}`);
    if (todo.length === 0) {
      console.log('Nothing to do — matrix is complete for this tuple.');
      return;
    }

    // 3. Embed (batched) — real token usage reported below.
    const client = new OpenAI({ apiKey, maxRetries: 5, timeout: 60_000 });
    const { vectors, totalTokens } = await embedBatch(
      client,
      todo.map((v) => v.text),
      model,
      dimensions,
    );

    // 4. Chunked multi-VALUES insert (7 params/row · 100 rows/stmt ≪ the 65535 param cap).
    let inserted = 0;
    const ROWS_PER_STMT = 100;
    for (let i = 0; i < todo.length; i += ROWS_PER_STMT) {
      const slice = todo.slice(i, i + ROWS_PER_STMT);
      const insertParams: unknown[] = [];
      const insertTuples = slice.map((v, j) => {
        const base = j * 7;
        insertParams.push(
          idByCanonical.get(v.canonical),
          v.variant,
          v.text,
          toSql(vectors[i + j]),
          model,
          dimensions,
          embeddingVersion,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::extensions.vector, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      const res = await pool.query(
        `INSERT INTO public.skill_embeddings
           (skill_id, variant, source_text, embedding, model, dimensions, embedding_version)
         VALUES ${insertTuples.join(', ')}
         ON CONFLICT (source_text, model, dimensions, embedding_version) DO NOTHING`,
        insertParams,
      );
      inserted += res.rowCount ?? 0;
    }

    // INVARIANT: the resolution cache is only valid against the matrix it was computed on.
    // New vectors can change any phrase's top-1/similarity, so a grown matrix invalidates
    // skill_resolutions for the tuple (cheap: each phrase re-resolves once, ~$0.0000004).
    if (inserted > 0) {
      const purged = await pool.query(
        `DELETE FROM public.skill_resolutions
          WHERE model = $1 AND dimensions = $2 AND embedding_version = $3`,
        [model, dimensions, embeddingVersion],
      );
      console.log(`Matrix grew → purged ${purged.rowCount ?? 0} cached resolutions for the tuple.`);
    }

    const estCost = (totalTokens / 1_000_000) * 0.13;
    console.log(
      `Done: inserted ${inserted}/${todo.length} rows · ${totalTokens} tokens · est $${estCost.toFixed(4)}`,
    );
    const countRes = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.skill_embeddings
        WHERE model = $1 AND dimensions = $2 AND embedding_version = $3`,
      [model, dimensions, embeddingVersion],
    );
    console.log(`Matrix size for tuple: ${countRes.rows[0].n} rows (expected ${variants.length})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`backfill failed: ${(err as Error).message}`);
  process.exit(1);
});
