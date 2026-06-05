/**
 * Shared embedding helpers for the semantic skill tier — used by BOTH
 * `src/tools/backfill-skill-embeddings.ts` (production matrix in pgvector) and
 * `src/calibration/eval-semantic.ts` (offline threshold sweep).
 *
 * Sharing this code is a CORRECTNESS requirement, not DRY hygiene: the threshold the
 * eval picks only transfers to production if both build the skill matrix from the
 * exact same (variant, text) set and the exact same embedding post-processing.
 */
import OpenAI from 'openai';
import { SkillTaxonomyService, TaxonomyEntry } from '../common/services/skill-taxonomy.service';

export type SkillVariantKind = 'canonical' | 'display' | 'alias';

export interface SkillVariant {
  /** canonical_name of the owning skill. */
  canonical: string;
  variant: SkillVariantKind;
  /** The surface form that gets embedded (exact text, stored in skill_embeddings.source_text). */
  text: string;
}

/**
 * One embedding text per DISTINCT normalized key per skill — canonical first, then display,
 * then aliases in file order (first-writer-wins, mirroring the alias-index semantics).
 * "React.js" / "ReactJS" collapse to one vector; near-duplicate vectors add cost, not recall.
 */
export function enumerateSkillVariants(entries: TaxonomyEntry[]): SkillVariant[] {
  const seen = new Set<string>();
  const out: SkillVariant[] = [];
  const push = (canonical: string, variant: SkillVariantKind, text: string): void => {
    const trimmed = (text ?? '').trim();
    if (trimmed.length === 0) return;
    const key = SkillTaxonomyService.normalizeKey(trimmed);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push({ canonical, variant, text: trimmed });
  };

  for (const entry of entries) {
    push(entry.canonical_name, 'canonical', entry.canonical_name);
    push(entry.canonical_name, 'display', entry.display_name);
    for (const alias of entry.aliases ?? []) push(entry.canonical_name, 'alias', alias);
  }
  return out;
}

/** Mirrors OpenAiProvider.embed post-processing: dimension assert + defensive re-normalize. */
export function postProcessEmbedding(vec: number[], dimensions: number, label: string): number[] {
  if (vec.length !== dimensions) {
    throw new Error(
      `Embedding dimension contract violated for "${label}": expected ${dimensions}, got ${vec.length}`,
    );
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0 && Math.abs(norm - 1) > 1e-3) {
    return vec.map((v) => v / norm);
  }
  return vec;
}

/**
 * Batch-embed texts (chunks of 500 — well under OpenAI's 2048-inputs/300k-token caps for
 * short phrases). Returns vectors aligned 1:1 with `texts`, plus total token usage.
 */
export async function embedBatch(
  client: OpenAI,
  texts: string[],
  model: string,
  dimensions: number,
): Promise<{ vectors: number[][]; totalTokens: number }> {
  const vectors: number[][] = [];
  let totalTokens = 0;
  const CHUNK = 500;
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    const response = await client.embeddings.create({
      model,
      input: chunk,
      dimensions,
    });
    // The API preserves input order via the `index` field — sort defensively anyway.
    const sorted = [...response.data].sort((a, b) => a.index - b.index);
    if (sorted.length !== chunk.length) {
      throw new Error(
        `Embeddings API returned ${sorted.length} vectors for ${chunk.length} inputs`,
      );
    }
    for (let j = 0; j < sorted.length; j++) {
      vectors.push(postProcessEmbedding(sorted[j].embedding, dimensions, chunk[j]));
    }
    totalTokens += response.usage?.total_tokens ?? 0;
  }
  return { vectors, totalTokens };
}

/** Dot product — valid cosine similarity because every vector is unit-length post-processed. */
export function cosineSim(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
