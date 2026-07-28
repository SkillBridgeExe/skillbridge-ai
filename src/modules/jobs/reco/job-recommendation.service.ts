import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { LlmService } from '../../../infrastructure/llm/llm.service';
import { SkillDiffService, DiffResult, RawCvSkill } from '../../cv-jd-match/skill-diff.service';
import { SkillTaxonomyService } from '../../../common/services/skill-taxonomy.service';
import { proficiencyHintForLevel } from '../../../common/services/proficiency-calibration';
import { rrfFuse } from './rrf';
import { CanonicalCvDocument } from '../../../common/types/canonical-cv';
import {
  loadLatestReviewSkills,
  toRawCvSkills,
  ScoreBasis,
} from '../../cv-jd-match/cv-review-facts';
import {
  deriveCvSeniority,
  computeExperienceFit,
  experienceNudge,
  recommendationSeniorityPolicy,
  ExperienceFit,
  CvSeniority,
} from '../../../common/services/seniority';
import { classifyFit, FitVerdict } from '../../gap-engine/fit-strategy';
import {
  fetchLatestInterviewSignalsForUser,
  InterviewSignalMap,
} from '../../../platform/interviews/interview-signals';
import { BUSINESS_JOB_ROLE_CODES } from '../../../platform/business-jobs/job-domain';
import {
  JobRecommendationFitVerdict,
  JobRecommendationSort,
} from '../dto/job-recommendation-query.dto';

export interface JobRecommendation {
  job_id: string;
  slug: string;
  application_mode: 'NATIVE' | 'EXTERNAL';
  saved: boolean;
  title: string;
  company_name: string;
  location: string | null;
  city_codes: string[];
  role_code: string | null;
  experience_level: string | null;
  work_mode: string | null;
  employment_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_visible: boolean;
  currency: string;
  source_url: string | null;
  posted_at: string | null;
  /** Deterministic MATCH_TUNING score (0-100) — same engine as CV/JD match. SKILL match only;
   *  unchanged by the seniority guard so the card stays explainable. */
  match_score: number;
  /** Seniority-adjusted ranking score (0-100) = match_score × recommendation seniority factor.
   *  Equals match_score when the candidate fits; demoted for `stretch` (esp. severe). What the
   *  ranking is actually sorted by — surfaced so the FE can show why a high-skill job ranks low. */
  recommendation_score: number;
  /** True when the job sits ≥ 3 seniority levels above the candidate (e.g. fresher → LEAD) — a severe
   *  stretch the FE can badge / filter from the default list. */
  severe_stretch: boolean;
  /** E5: the recommendationSeniorityPolicy() multiplier applied to match_score → recommendation_score
   *  (1 = no demotion). Additive — lets the FE explain a demoted score instead of just showing it. */
  seniority_factor: number;
  /** E5: job_level rank − cv rank (positive = job sits above the candidate); 0 when seniority is
   *  unknown/neutral. Same value recommendationSeniorityPolicy() derived the factor from. */
  level_gap: number;
  /** Cosine similarity of skill-set embeddings (null when the job has no vector). */
  semantic_similarity: number | null;
  /** RRF-fused rank position (1 = best). */
  rank: number;
  matched_skills: string[];
  /** canonical_name is additive — the FE's stable list key (display_name may collide/localize). */
  partial_skills: Array<{
    canonical_name: string;
    display_name: string;
    importance: string;
    gap_levels: number;
  }>;
  missing_skills: Array<{ display_name: string; importance: string }>;
  /** Same breakdown the score was computed from — lets the FE detail match the card exactly. */
  scoring_breakdown: DiffResult['scoring_breakdown'];
  experience_fit: ExperienceFit;
  /** Wave ACTION (A1): deterministic safe_apply/stretch/not_recommended verdict, input score =
   *  recommendation_score (the seniority-adjusted ranking score, not the raw skill match_score).
   *  `fit.reasons[]` never includes DEAL_BREAKER_UNMET here — see the asymmetry note below.
   *  Optional (additive, same convention as jd_dimensions?/inferred_skills? elsewhere) — always
   *  populated on the live path, only absent for pre-A1 reconstructed/cached rows. */
  fit?: FitVerdict;
  /** RECOMMENDATION' (R2/R3): what entered recommendation_score — 'skills_and_seniority' when a
   *  real seniority verdict applied, 'skills_only' when seniority was unknown (factor 1). The
   *  deal-breaker basis is never emitted here (pool jobs carry no jd_dimensions). Optional for the
   *  same additive/cached-row convention as `fit`. */
  score_basis?: ScoreBasis;
  /** R4 (RECOMMENDATION'): requirements of THIS job the user's latest COMPLETED interview flagged
   *  as knowledge/evidence gaps (risk 0-1, worst per skill; session_ref = session id prefix).
   *  CONFIDENCE OVERLAY ONLY — never raises or lowers ranking in v1 (a weak interview must not
   *  silently bury a job). Absent when no completed interview, no overlap, or lookup failed. */
  interview_signals?: Array<{
    skill_canonical: string;
    /** human label (InterviewGapItem.display_name) — FE chips must never show the raw canonical. */
    display_name: string;
    risk: number;
    session_ref: string;
  }>;
}

export interface JobRecommendationResponse {
  cv_id: string;
  /** Size after metadata filters, before fit-tier filtering. */
  pool_size: number;
  /** Active/canonical jobs in the effective role scope, before optional metadata filters. */
  eligible_pool_size: number;
  /** Total ranked recommendations after every filter — paginate with limit/offset to browse all. */
  total: number;
  /** Page size applied (default 5 for the headline; up to 50). */
  limit: number;
  /** Page offset applied (0-based). */
  offset: number;
  role_scope: {
    role_code: string | null;
    source: 'explicit' | 'cv_target' | 'all' | 'all_fallback';
  };
  filters_applied: {
    city_codes: string[];
    work_modes: string[];
    employment_types: string[];
    experience_levels: string[];
    fit: JobRecommendationFitVerdict[];
    salary_only: boolean;
    sort: JobRecommendationSort;
  };
  facets: JobRecommendationFacets;
  data_quality: {
    missing_role: number;
    missing_experience_level: number;
    missing_location: number;
    missing_work_mode: number;
  };
  recommendations: JobRecommendation[];
}

export interface JobRecommendationFacetValue {
  value: string;
  count: number;
}

export interface JobRecommendationFacets {
  city_codes: JobRecommendationFacetValue[];
  work_modes: JobRecommendationFacetValue[];
  employment_types: JobRecommendationFacetValue[];
  experience_levels: JobRecommendationFacetValue[];
  fit: JobRecommendationFacetValue[];
}

export interface JobRecommendationOptions {
  limit?: number;
  offset?: number;
  /** undefined = CV target role, null = explicit all roles, string = explicit role. */
  roleCode?: string | null;
  cityCodes?: string[];
  workModes?: string[];
  employmentTypes?: string[];
  experienceLevels?: string[];
  fitVerdicts?: JobRecommendationFitVerdict[];
  salaryOnly?: boolean;
  sort?: JobRecommendationSort;
}

export interface CandidateJobRow {
  id: string;
  slug: string;
  application_mode: 'NATIVE' | 'EXTERNAL';
  saved: boolean;
  title: string;
  company_name: string;
  location: string | null;
  primary_city_code?: string | null;
  location_city_codes?: string[] | null;
  role_code: string | null;
  experience_level: string | null;
  work_mode?: string | null;
  employment_type?: string | null;
  salary_min: string | null;
  salary_max: string | null;
  salary_visible: boolean;
  currency: string;
  source_url: string | null;
  posted_at: string | null;
  skills: Array<{ canonical: string; importance: string; min_level: number | null }>;
}

/**
 * Seniority-aware re-rank: adjusted = rrf × seniorityFactor + experienceNudge; sort desc, stable by id.
 *
 *  - The MULTIPLICATIVE factor (recommendationSeniorityPolicy) is a real demotion: a `stretch` job is
 *    scaled by 0.4–0.85, which reliably sinks it BELOW every full-factor (`fits`/`unknown`/`over`) job
 *    — so a fresher does not get SENIOR/LEAD jobs as normal top recommendations even on high skill
 *    overlap. Within one factor tier the RRF order (skill + semantic) is preserved (constant multiplier).
 *  - The additive nudge is retained as the original ~one-rank-step tie-breaker among same-factor jobs.
 *  When the whole pool is a stretch (e.g. only senior jobs exist), they are demoted equally and still
 *  surface — honest — flagged via `severe_stretch` on the response rather than hidden.
 */
export function rerankByExperience(
  fused: Map<string, number>,
  fitByJob: Map<string, ExperienceFit>,
): Array<[string, number]> {
  return [...fused.entries()]
    .map(([id, score]): [string, number] => {
      const fit = fitByJob.get(id);
      const { factor } = recommendationSeniorityPolicy(fit);
      return [id, score * factor + experienceNudge(fit)];
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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
    options: JobRecommendationOptions = {},
  ): Promise<JobRecommendationResponse> {
    // Default 5 (the headline top-5); cap 50/page so "see all" can paginate without huge payloads.
    // Number(NaN)||5 → a non-numeric ?limit falls back to 5 (not an empty result); 0→1 via Math.max.
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 50);
    const offset = Math.max(Number(options.offset) || 0, 0);

    // 1. Ownership + CV skills (persisted by the CV review pipeline).
    const cvRows = await this.db.query<{
      id: string;
      parsed_json: CanonicalCvDocument | null;
      target_role: string | null;
    }>(
      `SELECT id, parsed_json, target_role
         FROM public.cvs
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
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
    const targetRole = isRoleCode(cvRows[0].target_role) ? cvRows[0].target_role : null;
    const effectiveRole = options.roleCode === undefined ? targetRole : options.roleCode;
    const roleSource: JobRecommendationResponse['role_scope']['source'] =
      options.roleCode === null
        ? 'all'
        : options.roleCode !== undefined
          ? 'explicit'
          : targetRole
            ? 'cv_target'
            : 'all_fallback';

    // 2. Role-scoped pool first. Facets are derived from this stable pool, then user-selected
    // metadata filters narrow it before the expensive scoring/embedding stages.
    const eligibleCandidates = await this.db.query<CandidateJobRow>(
      `SELECT j.id, j.slug, j.application_mode,
              EXISTS (SELECT 1 FROM public.saved_jobs sj WHERE sj.job_id = j.id AND sj.user_id = $2) AS saved,
              j.title, c.name AS company_name, j.location, j.primary_city_code,
              j.location_city_codes, j.role_code, j.experience_level, j.work_mode,
              j.employment_type, j.salary_min, j.salary_max, j.salary_visible, j.currency, j.source_url,
              j.posted_at::text AS posted_at,
              COALESCE(
                json_agg(json_build_object('canonical', s.canonical_name, 'importance', js.importance, 'min_level', js.min_level))
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
          AND (
            j.application_mode = 'EXTERNAL'
            OR EXISTS (
              SELECT 1 FROM public.business_profiles bp
               WHERE bp.company_id = j.company_id AND bp.status = 'VERIFIED'
            )
          )
          AND ($1::varchar IS NULL OR j.role_code = $1)
        GROUP BY j.id, c.name
        ORDER BY j.id`, // deterministic source order → reproducible RRF for tied scores
      [effectiveRole, userId],
    );
    const facetsBeforeFit = buildMetadataFacets(eligibleCandidates);
    const dataQuality = buildRecommendationDataQuality(eligibleCandidates);
    const candidates = filterCandidateJobs(eligibleCandidates, options);
    if (candidates.length === 0 || cvCanonicals.length === 0) {
      return {
        cv_id: cvId,
        pool_size: candidates.length,
        eligible_pool_size: eligibleCandidates.length,
        total: 0,
        limit,
        offset,
        role_scope: { role_code: effectiveRole, source: roleSource },
        filters_applied: appliedFilters(options),
        facets: { ...facetsBeforeFit, fit: [] },
        data_quality: dataQuality,
        recommendations: [],
      };
    }

    // TRUST (B1): score jobs with the user's REAL proficiency from their latest CV review —
    // the same input class cv-jd-match uses — instead of presence-only (everything level 3).
    // Falls back to presence-only when no review exists (fresh CV, review failed).
    // R1: shared fact builder — the candidate apply/match path builds its facts the same way.
    const reviewSkills = await loadLatestReviewSkills(this.db, userId, cvId);
    const cvSkillsRaw: RawCvSkill[] = toRawCvSkills(reviewSkills, cvCanonicals);

    // R4: latest completed interview (any match) → per-skill risk map, fetched ONCE per request.
    // Confidence overlay only — it never enters rankA/rankB/RRF/rerank below. Never-throw.
    const interviewSignals = await fetchLatestInterviewSignalsForUser(this.db, userId);

    // 3. Signal A — deterministic skill match per candidate (pure code, reproducible).
    const diffByJob = new Map<string, ReturnType<SkillDiffService['diff']>>();
    for (const job of candidates) {
      const diff = this.skillDiff.diff({
        cv_skills_raw: cvSkillsRaw,
        jd_requirements_raw: job.skills.map((s) => ({
          name: s.canonical,
          importance_hint: s.importance,
          // Employer-posted jobs carry a REAL min_level (HR-entered, 1-5); honor it instead of
          // letting every requirement collapse to the engine's INTERMEDIATE default (which made
          // 'matched' trivially true for any listed skill). Scraped/manual jobs have no
          // min_level → undefined → engine default, unchanged behavior.
          required_level_hint: proficiencyHintForLevel(s.min_level),
        })),
      });
      diffByJob.set(job.id, diff);
    }
    const rankA = [...candidates]
      .sort(
        (a, b) =>
          (diffByJob.get(b.id)!.overall_score ?? 0) - (diffByJob.get(a.id)!.overall_score ?? 0) ||
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

    // 5. RRF fuse → soft tie-breaker re-rank by experience fit → slice the requested page.
    // fitByJob pre-computes experience fit for all candidates so rerankByExperience can apply
    // the nudge in O(n) without re-deriving per job. Stable tiebreak by job_id keeps pagination
    // reproducible across requests.
    const fitByJob = new Map<string, ExperienceFit>(
      candidates.map((c) => [c.id, computeExperienceFit(cvSeniority, c.experience_level)]),
    );
    const fused = rrfFuse(rankB.length > 0 ? [rankA, rankB] : [rankA]);
    const allRanked = rerankByExperience(fused, fitByJob);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    let allRecommendations: JobRecommendation[] = allRanked.map(([jobId], i) =>
      buildJobRecommendation(
        byId.get(jobId)!,
        diffByJob.get(jobId)!,
        i + 1,
        simByJob.has(jobId) ? Number(simByJob.get(jobId)!.toFixed(4)) : null,
        fitByJob.get(jobId)!,
        interviewSignals,
      ),
    );
    const fitFacets = countFacet(
      allRecommendations
        .map((recommendation) => recommendation.fit?.verdict)
        .filter((value): value is JobRecommendationFitVerdict => isString(value)),
    );
    if (options.fitVerdicts?.length) {
      const allowed = new Set(options.fitVerdicts);
      allRecommendations = allRecommendations.filter(
        (recommendation) => recommendation.fit?.verdict && allowed.has(recommendation.fit.verdict),
      );
    }
    allRecommendations = sortRecommendations(allRecommendations, options.sort ?? 'RECOMMENDED').map(
      (recommendation, index) => ({ ...recommendation, rank: index + 1 }),
    );
    const total = allRecommendations.length;
    const recommendations = allRecommendations.slice(offset, offset + limit);

    return {
      cv_id: cvId,
      pool_size: candidates.length,
      eligible_pool_size: eligibleCandidates.length,
      total,
      limit,
      offset,
      role_scope: { role_code: effectiveRole, source: roleSource },
      filters_applied: appliedFilters(options),
      facets: { ...facetsBeforeFit, fit: fitFacets },
      data_quality: dataQuality,
      recommendations,
    };
  }
}

/** Pure mapper: candidate row + its diff → API shape. Card and FE detail use the SAME diff. */
export function buildJobRecommendation(
  job: CandidateJobRow,
  diff: DiffResult,
  rank: number,
  semanticSimilarity: number | null,
  experienceFit: ExperienceFit,
  interviewSignals?: InterviewSignalMap,
): JobRecommendation {
  // R4: intersect the user's latest-interview risk map with THIS job's requirements. Annotation
  // only — computed after every score above is final, omitted (not []) when nothing overlaps.
  const interview_signals = interviewSignals
    ? job.skills
        .filter((s) => interviewSignals.has(s.canonical))
        .map((s) => {
          const signal = interviewSignals.get(s.canonical)!;
          return {
            skill_canonical: s.canonical,
            display_name: signal.display,
            risk: signal.risk,
            session_ref: signal.ref,
          };
        })
    : [];
  const policy = recommendationSeniorityPolicy(experienceFit);
  // ponytail: null overall_score (job with no scorable requirements) coerces to 0 — byte-identical
  // to pre-TRUST-prime behavior for such jobs. Honest-null on job cards = RECOMMENDATION wave.
  const recommendation_score = Math.round((diff.overall_score ?? 0) * policy.factor);
  // ponytail: unmet_deal_breakers is always [] here — pool jobs only carry job_skills (SkillDiffService
  // requirements), never the jd_dimensions block (deal_breaker/verdict) that only a pasted-JD match
  // extracts. Asymmetric vs. the gap-report path on purpose (see PR body); revisit if pool jobs ever
  // gain JD-derived dimensions.
  const fit = classifyFit({
    score: recommendation_score,
    required_coverage: diff.required_coverage,
    seniority_verdict: experienceFit.verdict,
    unmet_deal_breakers: [],
    level_gap: policy.level_gap,
    severe_stretch: policy.severe_stretch,
  });
  return {
    job_id: job.id,
    slug: job.slug,
    application_mode: job.application_mode,
    saved: job.saved,
    title: job.title,
    company_name: job.company_name,
    location: job.location,
    city_codes: job.location_city_codes?.length
      ? job.location_city_codes
      : job.primary_city_code
        ? [job.primary_city_code]
        : [],
    role_code: job.role_code,
    experience_level: job.experience_level,
    work_mode: job.work_mode ?? null,
    employment_type: job.employment_type ?? null,
    salary_min: job.salary_visible && job.salary_min ? Number(job.salary_min) : null,
    salary_max: job.salary_visible && job.salary_max ? Number(job.salary_max) : null,
    salary_visible: job.salary_visible,
    currency: job.currency,
    source_url: job.application_mode === 'EXTERNAL' ? job.source_url : null,
    posted_at: job.posted_at,
    match_score: diff.overall_score ?? 0,
    recommendation_score,
    severe_stretch: policy.severe_stretch,
    seniority_factor: policy.factor,
    level_gap: policy.level_gap,
    semantic_similarity: semanticSimilarity,
    rank,
    matched_skills: diff.matched_skills.map((s) => s.display_name),
    partial_skills: diff.partial_skills.map((s) => ({
      canonical_name: s.canonical_name,
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
    fit,
    // R2/R3: verdict unknown ⇒ the policy factor was 1 and seniority contributed nothing — the
    // honest basis is skills_only. Deal-breaker basis is unreachable here by construction (see
    // the unmet_deal_breakers:[] note above).
    score_basis: experienceFit.verdict === 'unknown' ? 'skills_only' : 'skills_and_seniority',
    ...(interview_signals.length > 0 ? { interview_signals } : {}),
  };
}

export function filterCandidateJobs(
  candidates: CandidateJobRow[],
  options: JobRecommendationOptions,
): CandidateJobRow[] {
  const cityCodes = new Set(options.cityCodes ?? []);
  const workModes = new Set(options.workModes ?? []);
  const employmentTypes = new Set(options.employmentTypes ?? []);
  const experienceLevels = new Set(options.experienceLevels ?? []);
  return candidates.filter((job) => {
    const jobCities = job.location_city_codes?.length
      ? job.location_city_codes
      : job.primary_city_code
        ? [job.primary_city_code]
        : [];
    if (cityCodes.size && !jobCities.some((city) => cityCodes.has(city))) return false;
    if (workModes.size && (!job.work_mode || !workModes.has(job.work_mode))) return false;
    if (employmentTypes.size && (!job.employment_type || !employmentTypes.has(job.employment_type)))
      return false;
    if (
      experienceLevels.size &&
      (!job.experience_level || !experienceLevels.has(job.experience_level))
    )
      return false;
    if (
      options.salaryOnly &&
      (!job.salary_visible || (job.salary_min === null && job.salary_max === null))
    )
      return false;
    return true;
  });
}

export function buildMetadataFacets(
  candidates: CandidateJobRow[],
): Omit<JobRecommendationFacets, 'fit'> {
  return {
    city_codes: countFacet(
      candidates.flatMap((job) =>
        job.location_city_codes?.length
          ? job.location_city_codes
          : job.primary_city_code
            ? [job.primary_city_code]
            : [],
      ),
    ),
    work_modes: countFacet(candidates.map((job) => job.work_mode).filter(isString)),
    employment_types: countFacet(candidates.map((job) => job.employment_type).filter(isString)),
    experience_levels: countFacet(candidates.map((job) => job.experience_level).filter(isString)),
  };
}

export function buildRecommendationDataQuality(
  candidates: CandidateJobRow[],
): JobRecommendationResponse['data_quality'] {
  return {
    missing_role: candidates.filter((job) => !job.role_code).length,
    missing_experience_level: candidates.filter((job) => !job.experience_level).length,
    missing_location: candidates.filter(
      (job) => !job.primary_city_code && !(job.location_city_codes?.length ?? 0),
    ).length,
    missing_work_mode: candidates.filter((job) => !job.work_mode).length,
  };
}

export function sortRecommendations(
  recommendations: JobRecommendation[],
  sort: JobRecommendationSort,
): JobRecommendation[] {
  const copy = [...recommendations];
  if (sort === 'SKILL_MATCH') {
    return copy.sort(
      (a, b) => b.match_score - a.match_score || b.recommendation_score - a.recommendation_score,
    );
  }
  if (sort === 'NEWEST') {
    return copy.sort(
      (a, b) =>
        timestamp(b.posted_at) - timestamp(a.posted_at) ||
        b.recommendation_score - a.recommendation_score,
    );
  }
  if (sort === 'SALARY_DESC') {
    return copy.sort(
      (a, b) =>
        (b.salary_max ?? b.salary_min ?? -1) - (a.salary_max ?? a.salary_min ?? -1) ||
        b.recommendation_score - a.recommendation_score,
    );
  }
  return copy.sort((a, b) => a.rank - b.rank);
}

function appliedFilters(
  options: JobRecommendationOptions,
): JobRecommendationResponse['filters_applied'] {
  return {
    city_codes: options.cityCodes ?? [],
    work_modes: options.workModes ?? [],
    employment_types: options.employmentTypes ?? [],
    experience_levels: options.experienceLevels ?? [],
    fit: options.fitVerdicts ?? [],
    salary_only: options.salaryOnly ?? false,
    sort: options.sort ?? 'RECOMMENDED',
  };
}

function countFacet(values: string[]): JobRecommendationFacetValue[] {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, count }));
}

function isRoleCode(value: string | null): value is string {
  return !!value && (BUSINESS_JOB_ROLE_CODES as readonly string[]).includes(value);
}

function isString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
