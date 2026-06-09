import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { LlmService } from '../../../infrastructure/llm/llm.service';
import { SkillDiffService, DiffResult } from '../../cv-jd-match/skill-diff.service';
import { SkillTaxonomyService } from '../../../common/services/skill-taxonomy.service';
import { rrfFuse } from './rrf';
import { CanonicalCvDocument } from '../../../common/types/canonical-cv';
import {
  deriveCvSeniority,
  computeExperienceFit,
  ExperienceFit,
  CvSeniority,
} from '../../../common/services/seniority';

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
  partial_skills: Array<{ display_name: string; importance: string; gap_levels: number }>;
  missing_skills: Array<{ display_name: string; importance: string }>;
  /** Same breakdown the score was computed from — lets the FE detail match the card exactly. */
  scoring_breakdown: DiffResult['scoring_breakdown'];
  experience_fit: ExperienceFit;
}

export interface JobRecommendationResponse {
  cv_id: string;
  /** Size of the candidate pool considered (active/canonical, role-filtered). */
  pool_size: number;
  /** Total ranked recommendations available — paginate with limit/offset to "see all". */
  total: number;
  /** Page size applied (default 5 for the headline; up to 50). */
  limit: number;
  /** Page offset applied (0-based). */
  offset: number;
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
    options: { limit?: number; offset?: number; roleCode?: string } = {},
  ): Promise<JobRecommendationResponse> {
    // Default 5 (the headline top-5); cap 50/page so "see all" can paginate without huge payloads.
    // Number(NaN)||5 → a non-numeric ?limit falls back to 5 (not an empty result); 0→1 via Math.max.
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 50);
    const offset = Math.max(Number(options.offset) || 0, 0);

    // 1. Ownership + CV skills (persisted by the CV review pipeline).
    const cvRows = await this.db.query<{ id: string; parsed_json: CanonicalCvDocument | null }>(
      `SELECT id, parsed_json FROM public.cvs WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [cvId, userId],
    );
    if (cvRows.length === 0) {
      throw new NotFoundException({ code: 'CV_NOT_FOUND', message: 'CV not found' });
    }
    const cvSeniority: CvSeniority | null = cvRows[0].parsed_json
      ? deriveCvSeniority(cvRows[0].parsed_json)
      : null;
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
        GROUP BY j.id, c.name
        ORDER BY j.id`, // deterministic source order → reproducible RRF for tied scores
      [options.roleCode ?? null],
    );
    if (candidates.length === 0 || cvCanonicals.length === 0) {
      return {
        cv_id: cvId,
        pool_size: candidates.length,
        total: 0,
        limit,
        offset,
        recommendations: [],
      };
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
      .sort(
        (a, b) =>
          diffByJob.get(b.id)!.overall_score - diffByJob.get(a.id)!.overall_score ||
          a.id.localeCompare(b.id), // explicit tiebreak — equal scores rank by stable id
      )
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
      // Restrict the dense ranking to the SAME candidate set (active/canonical/role-filtered)
      // BEFORE the LIMIT — otherwise expired/duplicate/out-of-role jobs steal the top-N dense
      // slots from real candidates (review finding). job_id = ANY($5) does that in-DB.
      const candIdArray = candidates.map((c) => c.id);
      const simRows = await this.db.query<{ job_id: string; similarity: number }>(
        `SELECT job_id, 1 - (embedding <=> $1::extensions.vector) AS similarity
           FROM public.job_embeddings
          WHERE model = $2 AND dimensions = $3 AND embedding_version = $4
            AND job_id = ANY($5)
          ORDER BY embedding <=> $1::extensions.vector`,
        [vectorLiteral, model, dimensions, version, candIdArray],
      );
      for (const row of simRows) {
        simByJob.set(row.job_id, Number(row.similarity));
        rankB.push(row.job_id);
      }
    } catch (err) {
      this.logger.warn(
        `dense signal degraded (skill-match-only ranking): ${(err as Error).message}`,
      );
      rankB = [];
    }

    // 5. RRF fuse → full ranking, then slice the requested page (stable tiebreak by job_id so
    // page boundaries are reproducible across requests — required for correct pagination).
    const fused = rrfFuse(rankB.length > 0 ? [rankA, rankB] : [rankA]);
    const allRanked = [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = allRanked.length;
    const page = allRanked.slice(offset, offset + limit);

    const byId = new Map(candidates.map((c) => [c.id, c]));
    const recommendations: JobRecommendation[] = page.map(([jobId], i) =>
      buildJobRecommendation(
        byId.get(jobId)!,
        diffByJob.get(jobId)!,
        offset + i + 1,
        simByJob.has(jobId) ? Number(simByJob.get(jobId)!.toFixed(4)) : null,
        computeExperienceFit(cvSeniority, byId.get(jobId)!.experience_level),
      ),
    );

    return { cv_id: cvId, pool_size: candidates.length, total, limit, offset, recommendations };
  }
}

/** Pure mapper: candidate row + its diff → API shape. Card and FE detail use the SAME diff. */
export function buildJobRecommendation(
  job: CandidateJobRow,
  diff: DiffResult,
  rank: number,
  semanticSimilarity: number | null,
  experienceFit: ExperienceFit,
): JobRecommendation {
  return {
    job_id: job.id,
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
    semantic_similarity: semanticSimilarity,
    rank,
    matched_skills: diff.matched_skills.map((s) => s.display_name),
    partial_skills: diff.partial_skills.map((s) => ({
      display_name: s.display_name,
      importance: s.importance,
      gap_levels: s.gap_levels,
    })),
    missing_skills: diff.missing_skills.map((s) => ({
      display_name: s.display_name,
      importance: s.importance,
    })),
    scoring_breakdown: diff.scoring_breakdown,
    experience_fit: experienceFit,
  };
}
