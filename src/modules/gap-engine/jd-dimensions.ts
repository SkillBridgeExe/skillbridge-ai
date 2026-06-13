/**
 * JD-Intelligence v2 (PR3) — the NON-SKILL JD requirement dimensions.
 *
 * The LLM (cv_jd_match_v2) extracts these as raw `jd_dimensions_raw[]`; this module holds the
 * canonical TYPES + a PURE coercer (`normalizeJdDimensions`) that hardens that loose LLM output into
 * a typed, honesty-gated `JdDimension[]`. No GapItem / severity logic lives here (that is in
 * gap-item.ts, which imports `JdDimension` from this file) — so the import graph stays one-way:
 *   gap-item.ts → jd-dimensions.ts → seniority.ts   (no cycle).
 *
 * SCOPE (PR3): all 5 dimension types are EXTRACTED (forward-compat), but only `seniority` is GRADED
 * into a GapItem (it is the sole dimension with a real CV-side signal via deriveCvSeniority). The
 * other four surface as a disclosure-only `jd_intelligence` block until a CV Profile Signals parser
 * lands (PR3b). Honesty rule, enforced here: a dimension with no JD quote (`evidence_text`) is DROPPED
 * — never fabricated.
 */
import { Importance } from '../../common/services/role-rubric.service';
import {
  BUCKET_RANK,
  CvSeniority,
  ExperienceVerdict,
  JOB_LEVEL_RANK,
  computeExperienceFit,
} from '../../common/services/seniority';

export type JdDimensionType = 'seniority' | 'language' | 'education' | 'domain' | 'work_mode';

const DIMENSION_TYPES: readonly JdDimensionType[] = [
  'seniority',
  'language',
  'education',
  'domain',
  'work_mode',
];
const IMPORTANCE_VALUES: readonly Importance[] = ['REQUIRED', 'PREFERRED', 'NICE_TO_HAVE'];

/** Loose shape the LLM emits per entry of jd_dimensions_raw[] — every field is untrusted. */
export interface RawJdDimension {
  dimension?: unknown;
  value_text?: unknown;
  level_hint?: unknown;
  min_years?: unknown;
  importance_hint?: unknown;
  deal_breaker?: unknown;
  evidence_text?: unknown;
}

/** Hardened, typed non-skill JD requirement. */
export interface JdDimension {
  dimension: JdDimensionType;
  /** The JD's stated requirement, e.g. "Senior", "English B2", "Bachelor in CS". */
  value_text: string;
  /** Seniority: a JOB_LEVEL_RANK key (INTERN..LEAD) or null. Other dims: the raw qualifier or null. */
  level_hint: string | null;
  min_years: number | null;
  importance: Importance;
  deal_breaker: boolean;
  /** MANDATORY exact JD quote — entries without it are dropped by normalizeJdDimensions (no fabrication). */
  evidence_text: string;
}

const coerceImportance = (v: unknown, dealBreaker: boolean): Importance => {
  if (dealBreaker) return 'REQUIRED';
  if (typeof v === 'string') {
    const up = v.trim().toUpperCase();
    if ((IMPORTANCE_VALUES as readonly string[]).includes(up)) return up as Importance;
  }
  return 'PREFERRED'; // a non-skill dim defaults to PREFERRED — never auto-REQUIRED without a signal
};

/**
 * PURE: harden raw LLM jd_dimensions_raw[] into typed JdDimension[]. Drops entries that are not a
 * known dimension type or carry no `evidence_text` (honesty: no JD quote ⇒ no dimension). For
 * seniority, `level_hint` is coerced to a known JOB_LEVEL_RANK key or set null (so a malformed level
 * can never be graded as a gap).
 */
export function normalizeJdDimensions(raw: unknown): JdDimension[] {
  if (!Array.isArray(raw)) return [];
  const out: JdDimension[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as RawJdDimension;

    const dim =
      typeof o.dimension === 'string'
        ? (o.dimension.trim().toLowerCase() as JdDimensionType)
        : null;
    if (!dim || !(DIMENSION_TYPES as readonly string[]).includes(dim)) continue;

    const evidence_text = typeof o.evidence_text === 'string' ? o.evidence_text.trim() : '';
    if (!evidence_text) continue; // no JD quote → drop (anti-fabrication)

    const value_text =
      typeof o.value_text === 'string' && o.value_text.trim() ? o.value_text.trim() : evidence_text;
    const deal_breaker = o.deal_breaker === true;
    const importance = coerceImportance(o.importance_hint, deal_breaker);

    let level_hint: string | null = null;
    if (typeof o.level_hint === 'string' && o.level_hint.trim()) {
      const lv = o.level_hint.trim();
      level_hint =
        dim === 'seniority' ? (lv.toUpperCase() in JOB_LEVEL_RANK ? lv.toUpperCase() : null) : lv;
    }

    const min_years =
      typeof o.min_years === 'number' && Number.isFinite(o.min_years) && o.min_years >= 0
        ? Math.floor(o.min_years)
        : null;

    out.push({
      dimension: dim,
      value_text,
      level_hint,
      min_years,
      importance,
      deal_breaker,
      evidence_text,
    });
  }
  return out;
}

/** The single seniority grading decision — SHARED by the gap_item builder and the jd_intelligence
 *  disclosure so the two can NEVER disagree. `dim` is the exact JdDimension element that was graded. */
export interface SeniorityGrade {
  dim: JdDimension;
  jdRank: number;
  cvRank: number;
  gap_levels: number;
  cv_status: 'matched' | 'missing';
  verdict: ExperienceVerdict;
}

/**
 * PURE: decide the ONE seniority grade (or null) from the extracted dims + CV signal. Reuses the
 * product-wide computeExperienceFit (±1 tolerance) as the single source of truth: within ±1 of the
 * JD level = 'fits'/'over_qualified' = matched (NO penalty); the candidate ≥2 levels below = 'stretch'
 * = a real gap (cv_status 'missing'). Honest omission → null when: no dims, no CV signal, low CV
 * confidence, or no valid-level seniority dim. Collapses duplicate/multiple seniority dims to the
 * STRICTEST (highest required rank) so there is AT MOST ONE seniority gap (stable requirement_id).
 */
export function gradeSeniority(
  dims: JdDimension[] | null | undefined,
  cvSeniority: CvSeniority | null | undefined,
): SeniorityGrade | null {
  if (!dims?.length || !cvSeniority || cvSeniority.confidence === 'low') return null;
  const seniorityDims = dims.filter(
    (d) =>
      d.dimension === 'seniority' && !!d.level_hint && JOB_LEVEL_RANK[d.level_hint] !== undefined,
  );
  if (seniorityDims.length === 0) return null;
  const dim = seniorityDims.reduce((a, b) =>
    (JOB_LEVEL_RANK[b.level_hint as string] ?? -1) > (JOB_LEVEL_RANK[a.level_hint as string] ?? -1)
      ? b
      : a,
  );
  const jdRank = JOB_LEVEL_RANK[dim.level_hint as string];
  const cvRank = BUCKET_RANK[cvSeniority.bucket];
  const verdict = computeExperienceFit(cvSeniority, dim.level_hint).verdict;
  const isGap = verdict === 'stretch'; // only ≥2 levels below the JD is a real seniority gap
  return {
    dim,
    jdRank,
    cvRank,
    gap_levels: isGap ? Math.max(0, jdRank - cvRank) : 0,
    cv_status: isGap ? 'missing' : 'matched',
    verdict,
  };
}
