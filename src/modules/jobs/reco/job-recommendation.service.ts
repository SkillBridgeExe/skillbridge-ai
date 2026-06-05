import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { LlmService } from '../../../infrastructure/llm/llm.service';
import { SkillDiffService } from '../../cv-jd-match/skill-diff.service';
import { SkillTaxonomyService } from '../../../common/services/skill-taxonomy.service';
import { rrfFuse } from './rrf';

export interface JobRecommendation {
  job_id: string;
  title: string;
  company_name: string;
  location: string | null;
  role_code: string | null;
  experience_level: string | null;
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
  source_url: string | null;
  posted_at: string | null;
  /** Deterministic MATCH_TUNING score (0-100) — same engine as CV/JD match. */
  match_score: number;
  /** Cosine similarity of skill-set embeddings (null when the job has no vector). */
  semantic_similarity: number | null;
  /** RRF-fused rank position (1 = best). */
  rank: number;
  matched_skills: string[];
  missing_skills: Array<{ display_name: string; importance: string }>;
}

export interface JobRecommendationResponse {
  cv_id: string;
  pool_size: number;
  recommendations: JobRecommendation[];
}

interface CandidateJobRow {
  id: string;
  title: string;
  company_name: string;
  location: string | null;
  role_code: string | null;
  experience_level: string | null;
  salary_min: string | null;
  salary_max: string | null;
  currency: string;
  source_url: string | null;
  posted_at: string | null;
  skills: Array<{ canonical: string; importance: string }>;
}

/**
 * Top-N job recommendations for a CV (J4) — HYBRID retrieval over the jobs pool:
 *
 *   signal A (sparse/deterministic): SkillDiffService with MATCH_TUNING — the SAME
 *     eval-gated engine as CV/JD match (importance multipliers, convex partial credit,
 *     required-coverage cap). Reproducible, explainable (matched/missing skills).
 *   signal B (dense): cosine between the CV's skill-set embedding and job_embeddings
 *     (same tuple as skill_embeddings — one geometry across CV/skill/job vectors).
 *   fusion: RRF (rank-based — no cross-signal score normalization needed).
 *
 * Pool filter: status='active', not expired, canonical representatives only
 * (canonical_job_id IS NULL — cross-board duplicates collapse to one entry).
 * Jobs without an embedding still compete via signal A alone (graceful degradation).
 */
@Injectable()
export class JobRecommendationService {
  private readonly logger = new Logger(JobRecommendationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly skillDiff: SkillDiffService,
    private readonly taxonomy: SkillTaxonomyService,
  ) {}

  async recommendForCv(
    userId: string,
    cvId: string,
    options: { limit?: number; roleCode?: string } = {},
  ): Promise<JobRecommendationResponse> {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);

    // 1. Ownership + CV skills (persisted by the CV review pipeline).
    const cvRows = await this.db.query<{ id: string }>(
      `SELECT id FROM public.cvs WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [cvId, userId],
    );
    if (cvRows.length === 0) {
      throw new NotFoundException({ code: 'CV_NOT_FOUND', message: 'CV not found' });
    }
    const cvSkillRows = await this.db.query<{ canonical_name: string }>(
      `SELECT s.canonical_name
         FROM public.cv_skills cs JOIN public.skills s ON s.id = cs.skill_id
        WHERE cs.cv_id = $1`,
      [cvId],
    );
    const cvCanonicals = cvSkillRows.map((r) => r.canonical_name);

    // 2. Candidate pool (active, unexpired, canonical representatives, with their skills).
    const candidates = await this.db.query<CandidateJobRow>(
      `SELECT j.id, j.title, c.name AS company_name, j.location, j.role_code,
              j.experience_level, j.salary_min, j.salary_max, j.currency, j.source_url,
              j.posted_at::text AS posted_at,
              COALESCE(
                json_agg(json_build_object('canonical', s.canonical_name, 'importance', js.importance))
                  FILTER (WHERE s.id IS NOT NULL),
                '[]'
              ) AS skills
         FROM public.jobs j
         JOIN public.companies c ON c.id = j.company_id
         LEFT JOIN public.job_skills js ON js.job_id = j.id
         LEFT JOIN public.skills s ON s.id = js.skill_id
        WHERE j.status = 'active'
          AND (j.expires_at IS NULL OR j.expires_at > now())
          AND j.canonical_job_id IS NULL
          AND ($1::varchar IS NULL OR j.role_code = $1)
        GROUP BY j.id, c.name`,
      [options.roleCode ?? null],
    );
    if (candidates.length === 0 || cvCanonicals.length === 0) {
      return { cv_id: cvId, pool_size: candidates.length, recommendations: [] };
    }

    // 3. Signal A — deterministic skill match per candidate (pure code, reproducible).
    const diffByJob = new Map<string, ReturnType<SkillDiffService['diff']>>();
    for (const job of candidates) {
      const diff = this.skillDiff.diff({
        cv_skills_raw: cvCanonicals.map((name) => ({ name })),
        jd_requirements_raw: job.skills.map((s) => ({
          name: s.canonical,
          importance_hint: s.importance,
        })),
      });
      diffByJob.set(job.id, diff);
    }
    const rankA = [...candidates]
      .sort((a, b) => diffByJob.get(b.id)!.overall_score - diffByJob.get(a.id)!.overall_score)
      .map((j) => j.id);

    // 4. Signal B — dense cosine rank (best-effort: pool stays usable without vectors).
    let rankB: string[] = [];
    const simByJob = new Map<string, number>();
    try {
      const model =
        this.config.get<string>('llm.openai.modelEmbedding') ?? 'text-embedding-3-large';
      const dimensions = this.config.get<number>('vector.dimension') ?? 1024;
      const version = this.config.get<string>('vector.embeddingVersion') ?? 'v1';
      // Same skill-set text construction as the job side (JdIngestService.embedJob).
      const cvText = cvCanonicals
        .map((c) => this.taxonomy.getByCanonical(c)?.display_name ?? c)
        .sort((a, b) => a.localeCompare(b, 'en'))
        .join(', ');
      const { embedding } = await this.llm.embed(cvText, { provider: 'openai', dimensions });
      const vectorLiteral = `[${embedding.join(',')}]`;
      const simRows = await this.db.query<{ job_id: string; similarity: number }>(
        `SELECT job_id, 1 - (embedding <=> $1::extensions.vector) AS similarity
           FROM public.job_embeddings
          WHERE model = $2 AND dimensions = $3 AND embedding_version = $4
          ORDER BY embedding <=> $1::extensions.vector
          LIMIT 200`,
        [vectorLiteral, model, dimensions, version],
      );
      const candidateIds = new Set(candidates.map((c) => c.id));
      for (const row of simRows) {
        if (!candidateIds.has(row.job_id)) continue;
        simByJob.set(row.job_id, Number(row.similarity));
        rankB.push(row.job_id);
      }
    } catch (err) {
      this.logger.warn(
        `dense signal degraded (skill-match-only ranking): ${(err as Error).message}`,
      );
      rankB = [];
    }

    // 5. RRF fuse → top N.
    const fused = rrfFuse(rankB.length > 0 ? [rankA, rankB] : [rankA]);
    const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

    const byId = new Map(candidates.map((c) => [c.id, c]));
    const recommendations: JobRecommendation[] = ordered.map(([jobId], i) => {
      const job = byId.get(jobId)!;
      const diff = diffByJob.get(jobId)!;
      return {
        job_id: jobId,
        title: job.title,
        company_name: job.company_name,
        location: job.location,
        role_code: job.role_code,
        experience_level: job.experience_level,
        salary_min: job.salary_min ? Number(job.salary_min) : null,
        salary_max: job.salary_max ? Number(job.salary_max) : null,
        currency: job.currency,
        source_url: job.source_url,
        posted_at: job.posted_at,
        match_score: diff.overall_score,
        semantic_similarity: simByJob.has(jobId) ? Number(simByJob.get(jobId)!.toFixed(4)) : null,
        rank: i + 1,
        matched_skills: diff.matched_skills.map((s) => s.display_name),
        missing_skills: diff.missing_skills.map((s) => ({
          display_name: s.display_name,
          importance: s.importance,
        })),
      };
    });

    return { cv_id: cvId, pool_size: candidates.length, recommendations };
  }
}
