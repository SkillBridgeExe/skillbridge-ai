import { LearningResource, OutcomeType, ResourceSourceType } from './learning-resource';

/**
 * The exact text indexed for a resource — CURATED METADATA ONLY (never copyrighted full course content).
 * Feeds BOTH the dense embedding and the sparse BM25 lane. Deterministic: same resource → same string.
 */
export function buildResourceSourceText(r: LearningResource): string {
  const skills = r.skills.map((s) => s.skill_canonical_name).join(', ');
  const desc = r.description?.trim() ? ` ${r.description.trim()}` : '';
  return `${r.title} — ${r.provider}.${desc} Teaches: ${skills}. Outcome: ${r.outcome_type}.`;
}

/** Resources eligible for the index: everything except dead_link (a pending→verified flip needs no re-embed). */
export function selectEmbeddableResources(catalog: LearningResource[]): LearningResource[] {
  return catalog.filter((r) => r.validation_status !== 'dead_link');
}

// --- Sparse lane: in-memory BM25 over the catalog text (the exact-term half of hybrid retrieval) ---

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'or',
  'for',
  'in',
  'on',
  'with',
  'do',
  'how',
  'i',
  'is',
  'it',
  'my',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Standard Okapi BM25 (k1=1.5, b=0.75) over a small in-memory corpus → resource_ids ranked by lexical
 * relevance (score>0 only). The sparse half of hybrid retrieval: catches exact terms (skill names, tech
 * keywords) that dense embeddings can underweight. Deterministic (id tiebreak); empty when nothing matches.
 */
export function bm25Search(
  query: string,
  corpus: { id: string; text: string }[],
  topK = 10,
): string[] {
  const k1 = 1.5;
  const b = 0.75;
  const docs = corpus.map((d) => ({ id: d.id, tokens: tokenize(d.text) }));
  const N = docs.length;
  if (N === 0) return [];
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;

  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const qTerms = [...new Set(tokenize(query))];
  const scored = docs.map((d) => {
    const dl = d.tokens.length;
    const tf = new Map<string, number>();
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of qTerms) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * dl) / avgdl));
    }
    return { id: d.id, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, c) => c.score - a.score || (a.id < c.id ? -1 : 1))
    .slice(0, topK)
    .map((s) => s.id);
}

// --- Resolve fused ranks → citable metadata (verified-only; the chatbot never sees a raw URL it can fake) ---

export interface RetrievedResource {
  resource_id: string;
  rank: number; // 1-based position in the final fused+filtered list
  title: string;
  provider: string;
  url?: string;
  source_type: ResourceSourceType;
  outcome_type: OutcomeType;
  proof_of_completion?: string;
}

/**
 * Join fused resource_ids → catalog metadata, VERIFIED-ONLY (the citable set), with an optional language
 * filter + topK. Unknown ids dropped; fused order preserved; rank stamped post-filter. The retriever
 * returns only resource_id + resolved metadata → a hallucinated URL is structurally impossible.
 */
export function resolveResources(
  rankedIds: string[],
  catalog: LearningResource[],
  opts?: { language?: string; topK?: number },
): RetrievedResource[] {
  const byId = new Map(catalog.map((r) => [r.id, r]));
  const out: RetrievedResource[] = [];
  for (const id of rankedIds) {
    const r = byId.get(id);
    if (!r || r.validation_status !== 'verified') continue;
    if (opts?.language && r.language !== opts.language) continue;
    out.push({
      resource_id: r.id,
      rank: out.length + 1,
      title: r.title,
      provider: r.provider,
      url: r.url,
      source_type: r.source_type,
      outcome_type: r.outcome_type,
      proof_of_completion: r.proof_of_completion,
    });
    if (opts?.topK && out.length >= opts.topK) break;
  }
  return out;
}
