import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../infrastructure/database/database.service';

export interface SkillDemandRow {
  canonical_name: string;
  display_name: string;
  posting_count: number;
  pct_of_postings: number;
  /** Median monthly salary across VND-denominated postings naming the skill (null = no data). */
  salary_p50_vnd: number | null;
  /**
   * Δ posting_count vs the previous snapshot period. null ONLY when no prior period exists
   * (first snapshot). A skill new in this period (absent before) reports delta = posting_count.
   */
  trend_delta: number | null;
}

export interface SkillTrendsResponse {
  role_code: string;
  period: string;
  total_active_jobs: number;
  skills: SkillDemandRow[];
}

export interface SkillGapRow extends SkillDemandRow {
  /** true = the CV already evidences this skill. */
  covered: boolean;
}

export interface SkillGapResponse {
  cv_id: string;
  role_code: string;
  period: string;
  /** Top in-demand skills for the role, each flagged covered/missing for THIS CV. */
  skills: SkillGapRow[];
  /** The missing subset, ordered by demand — the upskilling suggestion list. */
  gap: SkillGapRow[];
}

/**
 * J5 — skill-demand trend analytics over the jobs pool.
 *
 * refreshSnapshots() materializes per-(skill, role, period=today) counts into
 * skill_demand_snapshots — UPSERT semantics, so re-runs within a day are idempotent and
 * tomorrow's run opens a new period (the time series "skill mới nổi" needs ≥2 periods).
 * Invoke via `pnpm trends:refresh` from ANY external scheduler — deliberately NOT an
 * in-process @Cron: the Render free tier sleeps, so in-app cron silently never fires.
 *
 * salary_p50 is computed over VND-denominated postings ONLY — the pool mixes USD/VND and
 * a cross-currency median is meaningless (documented limitation; FX-normalize later).
 *
 * 'all' is a reserved role_code aggregating every active job (matches the column default).
 */
@Injectable()
export class SkillDemandService {
  private readonly logger = new Logger(SkillDemandService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Materialize today's snapshot for 'all' + every classified role. Returns rows written. */
  async refreshSnapshots(): Promise<number> {
    const result = await this.db.query<{ n: string }>(
      `WITH active AS (
         SELECT id, role_code,
                CASE WHEN currency = 'VND' AND (salary_min IS NOT NULL OR salary_max IS NOT NULL)
                     THEN (COALESCE(salary_min, salary_max) + COALESCE(salary_max, salary_min)) / 2
                END AS mid_salary_vnd
           FROM public.jobs
          WHERE status = 'active'
            AND (expires_at IS NULL OR expires_at > now())
            AND canonical_job_id IS NULL
       ),
       scopes AS (
         SELECT 'all'::varchar AS role_code, id, mid_salary_vnd FROM active
         UNION ALL
         SELECT role_code, id, mid_salary_vnd FROM active WHERE role_code IS NOT NULL
       ),
       scope_totals AS (
         SELECT role_code, count(*) AS total FROM scopes GROUP BY role_code
       ),
       per_skill AS (
         SELECT sc.role_code, js.skill_id,
                count(DISTINCT sc.id) AS cnt,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY sc.mid_salary_vnd)
                  FILTER (WHERE sc.mid_salary_vnd IS NOT NULL) AS p50
           FROM public.job_skills js
           JOIN scopes sc ON sc.id = js.job_id
          GROUP BY sc.role_code, js.skill_id
       ),
       written AS (
         INSERT INTO public.skill_demand_snapshots
           (skill_id, role_code, period, posting_count, pct_of_postings, salary_p50)
         SELECT ps.skill_id, ps.role_code, CURRENT_DATE, ps.cnt,
                round(ps.cnt * 100.0 / NULLIF(st.total, 0), 2), ps.p50
           FROM per_skill ps
           JOIN scope_totals st ON st.role_code = ps.role_code
         ON CONFLICT (skill_id, role_code, period) DO UPDATE SET
           posting_count = EXCLUDED.posting_count,
           pct_of_postings = EXCLUDED.pct_of_postings,
           salary_p50 = EXCLUDED.salary_p50
         RETURNING 1
       )
       SELECT count(*)::text AS n FROM written`,
    );
    const written = Number(result[0]?.n ?? 0);
    this.logger.log(`skill_demand_snapshots refreshed: ${written} rows (period=today)`);
    return written;
  }

  /** Top in-demand skills for a role at the LATEST snapshot, with Δ vs the previous period. */
  async getTrends(roleCode = 'all', limit = 20): Promise<SkillTrendsResponse> {
    const rows = await this.db.query<{
      canonical_name: string;
      display_name: string;
      posting_count: number;
      pct_of_postings: string | null;
      salary_p50: string | null;
      prev_count: number | null;
      period: string;
      has_prev: boolean;
    }>(
      `WITH latest AS (
         SELECT max(period) AS period FROM public.skill_demand_snapshots WHERE role_code = $1
       ),
       prev AS (
         SELECT max(period) AS period FROM public.skill_demand_snapshots
          WHERE role_code = $1 AND period < (SELECT period FROM latest)
       )
       SELECT s.canonical_name, s.display_name, cur.posting_count,
              cur.pct_of_postings::text, cur.salary_p50::text,
              p.posting_count AS prev_count, cur.period::text AS period,
              (SELECT period FROM prev) IS NOT NULL AS has_prev
         FROM public.skill_demand_snapshots cur
         JOIN public.skills s ON s.id = cur.skill_id
         LEFT JOIN public.skill_demand_snapshots p
           ON p.skill_id = cur.skill_id AND p.role_code = cur.role_code
          AND p.period = (SELECT period FROM prev)
        WHERE cur.role_code = $1 AND cur.period = (SELECT period FROM latest)
        ORDER BY cur.posting_count DESC, s.canonical_name ASC
        LIMIT $2`,
      // Number(NaN)||20 guards a non-numeric ?limit that would otherwise bind "NaN" → SQL 500.
      [roleCode, Math.min(Math.max(Number(limit) || 20, 1), 106)],
    );
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'NO_SNAPSHOT',
        message: `No snapshot for role '${roleCode}' — run trends:refresh first`,
      });
    }
    const totalRows = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM public.jobs
        WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
          AND canonical_job_id IS NULL
          AND ($1 = 'all' OR role_code = $1)`,
      [roleCode],
    );

    return {
      role_code: roleCode,
      period: rows[0].period,
      total_active_jobs: Number(totalRows[0].total),
      skills: rows.map((r) => ({
        canonical_name: r.canonical_name,
        display_name: r.display_name,
        posting_count: r.posting_count,
        pct_of_postings: r.pct_of_postings ? Number(r.pct_of_postings) : 0,
        salary_p50_vnd: r.salary_p50 ? Number(r.salary_p50) : null,
        // null ONLY when there is no prior period at all. When a prior period exists but this
        // skill was absent from it, the skill is NEW → delta = its full posting_count (the
        // "emerging skill" signal the trends feature is for).
        trend_delta: !r.has_prev ? null : r.posting_count - (r.prev_count ?? 0),
      })),
    };
  }

  /**
   * CV-gap upskilling suggestions: the role's top in-demand skills, each flagged
   * covered/missing for this CV; `gap` = missing subset ordered by demand.
   */
  async getSkillGap(
    userId: string,
    cvId: string,
    roleCode: string,
    limit = 15,
  ): Promise<SkillGapResponse> {
    const cvRows = await this.db.query<{ id: string }>(
      `SELECT id FROM public.cvs WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [cvId, userId],
    );
    if (cvRows.length === 0) {
      throw new NotFoundException({ code: 'CV_NOT_FOUND', message: 'CV not found' });
    }

    const trends = await this.getTrends(roleCode, limit);
    const cvSkillRows = await this.db.query<{ canonical_name: string }>(
      `SELECT s.canonical_name
         FROM public.cv_skills cs JOIN public.skills s ON s.id = cs.skill_id
        WHERE cs.cv_id = $1`,
      [cvId],
    );
    const covered = new Set(cvSkillRows.map((r) => r.canonical_name));

    const skills: SkillGapRow[] = trends.skills.map((s) => ({
      ...s,
      covered: covered.has(s.canonical_name),
    }));
    return {
      cv_id: cvId,
      role_code: roleCode,
      period: trends.period,
      skills,
      gap: skills.filter((s) => !s.covered),
    };
  }
}
