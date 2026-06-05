import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { DatabaseService } from '../../infrastructure/database/database.service';
import { EmbeddingTuple, PgVectorService } from '../../infrastructure/vector/pgvector.service';
import { SkillTaxonomyService } from './skill-taxonomy.service';

/** Outcome bands of the semantic tier (also the CHECK constraint on skill_resolutions.band). */
export type SemanticBand = 'auto' | 'needs_review' | 'none';

export interface SemanticResolution {
  canonicalName: string;
  similarity: number;
}

interface CachedResolution {
  band: SemanticBand;
  similarity: string | number | null;
  canonical_name: string | null;
}

/**
 * Embedding-based LAST-RESORT skill resolver (R2 step 7, blueprint semantic tier).
 *
 * Position in the cascade: fires ONLY for mentions the deterministic cascade
 * (exact → alias → umbrella → strip → split → token → fuzzy) returned [] for —
 * it can never override or compete with a deterministic hit.
 *
 * 3-band gate (thresholds from config `semantic.*`, tuned by `pnpm eval:semantic`):
 *   similarity ≥ accept                  → 'auto'         → resolve to the canonical
 *   accept − reviewBand ≤ sim < accept   → 'needs_review' → DO NOT resolve; cache + log for humans
 *   below                                → 'none'         → unresolved
 *
 * Every outcome is written to `skill_resolutions` (read-through cache keyed by the
 * normalized phrase + the FULL embedding tuple) so each distinct phrase costs at most
 * one embeddings call per embedding_version — bumping VECTOR_EMBEDDING_VERSION
 * invalidates the cache naturally.
 *
 * FAILURE POSTURE: best-effort. Any error (no DB, no key, OpenAI down, table missing)
 * logs a warning and resolves NOTHING — deterministic results must never be degraded
 * by this tier. NODE_ENV=test no-ops entirely (offline-contract: jest/e2e/eval harnesses
 * stay DB- and key-free).
 *
 * OpenAI-only by design: the tier targets the same embedding space as the backfilled
 * `skill_embeddings` matrix (text-embedding-3-large @1024). Provider routing is pinned,
 * not inherited from LLM_PROVIDER_DEFAULT.
 */
@Injectable()
export class SemanticSkillMatcherService {
  private readonly logger = new Logger(SemanticSkillMatcherService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly vector: PgVectorService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * Offline no-op contract: disabled under NODE_ENV=test, without an OpenAI key,
   * or without a DATABASE_URL. Callers (SkillNormalizerService) check this before
   * paying the async cost.
   */
  isEnabled(): boolean {
    if (this.config.get<string>('nodeEnv') === 'test' || process.env.NODE_ENV === 'test') {
      return false;
    }
    if (!this.config.get<string>('llm.openai.apiKey')) return false;
    if (!this.config.get<string>('database.url')) return false;
    return true;
  }

  /**
   * Per-batch (per-CV) ceiling on semantic resolutions — bounds the serial embed
   * round-trips one CV-review request can trigger on a cold cache (review finding).
   */
  getMaxPerBatch(): number {
    return this.config.get<number>('semantic.maxPerBatch') ?? 16;
  }

  /**
   * Resolve a single unresolved mention. Returns the canonical ONLY for band 'auto';
   * 'needs_review' and 'none' (and every failure) return null.
   */
  async resolve(rawPhrase: string): Promise<SemanticResolution | null> {
    if (!this.isEnabled()) return null;
    const phraseNorm = SkillTaxonomyService.normalizeKey(rawPhrase);
    if (phraseNorm.length === 0) return null;

    const tuple = this.embeddingTuple();
    try {
      const cached = await this.readCache(phraseNorm, tuple);
      if (cached) {
        if (cached.band === 'auto' && cached.canonical_name) {
          return {
            canonicalName: cached.canonical_name,
            similarity: Number(cached.similarity ?? 0),
          };
        }
        // auto-with-deleted-skill (FK SET NULL) degrades to unresolved — log once per hit.
        if (cached.band === 'auto' && !cached.canonical_name) {
          this.logger.warn(
            `skill_resolutions has band=auto but the resolved skill row is gone (phrase_norm=${phraseNorm}); treating as unresolved.`,
          );
        }
        return null;
      }

      const { embedding } = await this.llm.embed(rawPhrase, {
        provider: 'openai',
        dimensions: tuple.dimensions,
      });
      const nearest = await this.vector.nearestSkill(embedding, tuple);
      if (!nearest) {
        // Backfill not run for this tuple — nothing to compare against. Do NOT cache 'none'
        // (the phrase may resolve fine once the matrix exists).
        this.logger.warn(
          `skill_embeddings has no rows for tuple ${tuple.model}/${tuple.dimensions}/${tuple.embeddingVersion} — semantic tier idle (run embeddings backfill).`,
        );
        return null;
      }

      const { accept, review } = this.thresholds();
      const band: SemanticBand =
        nearest.similarity >= accept
          ? 'auto'
          : nearest.similarity >= accept - review
            ? 'needs_review'
            : 'none';

      await this.writeCache(
        phraseNorm,
        rawPhrase,
        band,
        nearest.similarity,
        tuple,
        {
          auto: nearest.skillId,
          needs_review: nearest.skillId, // keep the candidate so humans can review the suggestion
          none: null,
        }[band],
      );

      if (band === 'needs_review') {
        // Surface WHICH surface form matched (canonical/display/alias text) — the reviewer
        // needs it to judge the suggestion.
        this.logger.log(
          `semantic needs_review: "${rawPhrase}" → ${nearest.canonicalName} via "${nearest.sourceText}" (sim=${nearest.similarity.toFixed(4)}, accept=${accept})`,
        );
        return null;
      }
      if (band === 'none') return null;
      return { canonicalName: nearest.canonicalName, similarity: nearest.similarity };
    } catch (err) {
      // Best-effort tier: never let an embedding/DB failure break CV processing.
      this.logger.warn(`semantic tier degraded for "${rawPhrase}": ${(err as Error).message}`);
      return null;
    }
  }

  private embeddingTuple(): EmbeddingTuple {
    return {
      model: this.config.get<string>('llm.openai.modelEmbedding') ?? 'text-embedding-3-large',
      dimensions: this.config.get<number>('vector.dimension') ?? 1024,
      embeddingVersion: this.config.get<string>('vector.embeddingVersion') ?? 'v1',
    };
  }

  private thresholds(): { accept: number; review: number } {
    // Fallbacks mirror the eval-tuned config defaults (configuration.ts) — never a stale value:
    // if config wiring ever regresses, the tier must not silently accept at an un-tuned bar.
    return {
      accept: this.config.get<number>('semantic.acceptThreshold') ?? 0.72,
      review: this.config.get<number>('semantic.reviewBandWidth') ?? 0.08,
    };
  }

  private async readCache(
    phraseNorm: string,
    tuple: EmbeddingTuple,
  ): Promise<CachedResolution | null> {
    const rows = await this.db.query<CachedResolution>(
      `SELECT r.band, r.similarity, s.canonical_name
         FROM public.skill_resolutions r
         LEFT JOIN public.skills s ON s.id = r.resolved_skill_id
        WHERE r.phrase_norm = $1 AND r.model = $2 AND r.dimensions = $3 AND r.embedding_version = $4
        LIMIT 1`,
      [phraseNorm, tuple.model, tuple.dimensions, tuple.embeddingVersion],
    );
    return rows[0] ?? null;
  }

  private async writeCache(
    phraseNorm: string,
    phraseRaw: string,
    band: SemanticBand,
    similarity: number,
    tuple: EmbeddingTuple,
    resolvedSkillId: string | null,
  ): Promise<void> {
    // First-writer-wins under concurrency (same posture as the alias index).
    await this.db.query(
      `INSERT INTO public.skill_resolutions
         (phrase_norm, phrase_raw, resolved_skill_id, band, similarity, model, dimensions, embedding_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (phrase_norm, model, dimensions, embedding_version) DO NOTHING`,
      [
        phraseNorm,
        phraseRaw,
        resolvedSkillId,
        band,
        similarity.toFixed(4),
        tuple.model,
        tuple.dimensions,
        tuple.embeddingVersion,
      ],
    );
  }
}
