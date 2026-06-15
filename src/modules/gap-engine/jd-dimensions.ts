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
import {
  Cefr,
  CEFR_RANK,
  DegreeLevel,
  DEGREE_RANK,
  SignalConfidence,
  CvProfileSignals,
  classifyDegree,
  classifyDomains,
  parseEnglishRequirement,
} from '../../common/services/cv-profile-signals';

export type JdDimensionType = 'seniority' | 'language' | 'education' | 'domain' | 'work_mode';

const DIMENSION_TYPES: readonly JdDimensionType[] = [
  'seniority',
  'language',
  'education',
  'domain',
  'work_mode',
];
const IMPORTANCE_VALUES: readonly Importance[] = ['REQUIRED', 'PREFERRED', 'NICE_TO_HAVE'];
const IMPORTANCE_ORDER: Record<Importance, number> = { REQUIRED: 2, PREFERRED: 1, NICE_TO_HAVE: 0 };

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
  const dim = seniorityDims.reduce((a, b) => {
    const ra = JOB_LEVEL_RANK[a.level_hint as string] ?? -1;
    const rb = JOB_LEVEL_RANK[b.level_hint as string] ?? -1;
    if (rb !== ra) return rb > ra ? b : a;
    // Tie on required rank → keep the MORE SEVERE: deal-breaker, then importance, then total min_years —
    // so a SENIOR/PREFERRED listed before a SENIOR/REQUIRED deal-breaker never wins (P2 fix).
    if (a.deal_breaker !== b.deal_breaker) return b.deal_breaker ? b : a;
    const ia = IMPORTANCE_ORDER[a.importance] ?? 0;
    const ib = IMPORTANCE_ORDER[b.importance] ?? 0;
    if (ib !== ia) return ib > ia ? b : a;
    return (b.min_years ?? -1) > (a.min_years ?? -1) ? b : a;
  });
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

// ── Non-skill graders (PR3c): language / education / domain ─────────────────────────────────────
// The CV-side mirror of gradeSeniority for the three remaining dimensions WITH a CV-side signal.
// work_mode is deliberately NOT graded (disclosure-only) — its CV signal is structurally low-confidence
// and a logistics preference, not a capability gap. HONEST-BY-DEFAULT: returns null when the JD level
// is unparseable, or (per the confirmed policy) when the CV is SILENT and the JD requirement is not a
// hard one. Reuses computeSeverity UNCHANGED downstream by mapping rank diffs onto 0-5 gap_levels.

export type NonSkillStatus = 'matched' | 'partial' | 'missing';

/** A graded non-skill dimension decision — SHARED by gap-item (→ GapItem) and gap-report
 *  (→ jd_intelligence.graded), so the two can never contradict. `dims` are the JD dims it consumed. */
export interface DimensionGrade {
  type: 'language' | 'education' | 'domain';
  canonical_name: string;
  dims: JdDimension[];
  cv_status: NonSkillStatus;
  /** Rank on the dimension's scale (CEFR 1-6 / degree 1-5); null when unknown (CV silent) or N/A (domain). */
  cv_level: number | null;
  required_level: number | null;
  gap_levels: number;
  importance: Importance;
  /** 0-1, <1 (LLM-extracted JD requirement). From the CV signal's confidence, or 0.5 inferred-from-silence. */
  confidence: number;
  /** true when the gap was inferred from CV SILENCE (not an evidenced lower signal) — drives wording. */
  from_silence: boolean;
}

const confFromSignal = (c: SignalConfidence): number =>
  c === 'high' ? 0.8 : c === 'medium' ? 0.7 : 0.6;
const SILENCE_CONFIDENCE = 0.5;
/** A CV-silent gap is only surfaced for a HARD requirement (REQUIRED or deal-breaker) — conservative. */
const isHardRequirement = (d: JdDimension): boolean =>
  d.importance === 'REQUIRED' || d.deal_breaker;

/** Pick the STRICTEST candidate: highest rank, tie → deal-breaker then importance (order-independent). */
function pickStrictest<T extends { dim: JdDimension; rank: number }>(cands: T[]): T {
  return cands.reduce((a, b) => {
    if (b.rank !== a.rank) return b.rank > a.rank ? b : a;
    if (a.dim.deal_breaker !== b.dim.deal_breaker) return b.dim.deal_breaker ? b : a;
    const ia = IMPORTANCE_ORDER[a.dim.importance] ?? 0;
    const ib = IMPORTANCE_ORDER[b.dim.importance] ?? 0;
    return ib > ia ? b : a;
  });
}

/** PURE: grade the JD's English requirement against the CV english signal (CEFR ordered scale). */
export function gradeLanguage(
  dims: JdDimension[] | null | undefined,
  signals: CvProfileSignals | null | undefined,
): DimensionGrade | null {
  const cands = (dims ?? [])
    .filter((d) => d.dimension === 'language')
    .map((d) => ({
      dim: d,
      cefr: parseEnglishRequirement(`${d.value_text} ${d.level_hint ?? ''} ${d.evidence_text}`),
    }))
    .filter((c): c is { dim: JdDimension; cefr: Cefr } => c.cefr !== null)
    .map((c) => ({ dim: c.dim, rank: CEFR_RANK[c.cefr] }));
  if (cands.length === 0) return null;
  const best = pickStrictest(cands);
  const jdRank = best.rank;
  const cv = signals?.english ?? null;
  if (cv) {
    const cvRank = CEFR_RANK[cv.cefr];
    let cv_status: NonSkillStatus;
    let gap_levels: number;
    if (cvRank >= jdRank) {
      cv_status = 'matched';
      gap_levels = 0;
    } else if (cvRank === jdRank - 1) {
      cv_status = 'partial';
      gap_levels = 1;
    } else {
      cv_status = 'missing';
      gap_levels = jdRank - cvRank;
    }
    return {
      type: 'language',
      canonical_name: 'language',
      dims: [best.dim],
      cv_status,
      cv_level: cvRank,
      required_level: jdRank,
      gap_levels,
      importance: best.dim.importance,
      confidence: confFromSignal(cv.confidence),
      from_silence: false,
    };
  }
  if (!isHardRequirement(best.dim)) return null; // CV silent + soft requirement → honest omission
  return {
    type: 'language',
    canonical_name: 'language',
    dims: [best.dim],
    cv_status: 'missing',
    cv_level: null,
    required_level: jdRank,
    gap_levels: jdRank,
    importance: best.dim.importance,
    confidence: SILENCE_CONFIDENCE,
    from_silence: true,
  };
}

/** PURE: grade the JD's education requirement against the CV degree signal (degree ordered scale,
 *  NO partial bucket — at/above = matched, below = missing). field-only (level null) is treated as silent. */
export function gradeEducation(
  dims: JdDimension[] | null | undefined,
  signals: CvProfileSignals | null | undefined,
): DimensionGrade | null {
  const cands = (dims ?? [])
    .filter((d) => d.dimension === 'education')
    .map((d) => ({
      dim: d,
      level: classifyDegree(`${d.value_text} ${d.level_hint ?? ''} ${d.evidence_text}`),
    }))
    .filter((c): c is { dim: JdDimension; level: DegreeLevel } => c.level !== null)
    .map((c) => ({ dim: c.dim, rank: DEGREE_RANK[c.level] }));
  if (cands.length === 0) return null;
  const best = pickStrictest(cands);
  const jdRank = best.rank;
  const edu = signals?.education ?? null;
  const cvLevel = edu?.level ?? null;
  if (edu && cvLevel) {
    const cvRank = DEGREE_RANK[cvLevel];
    const matched = cvRank >= jdRank;
    return {
      type: 'education',
      canonical_name: 'education',
      dims: [best.dim],
      cv_status: matched ? 'matched' : 'missing',
      cv_level: cvRank,
      required_level: jdRank,
      gap_levels: matched ? 0 : jdRank - cvRank,
      importance: best.dim.importance,
      confidence: confFromSignal(edu.confidence),
      from_silence: false,
    };
  }
  if (!isHardRequirement(best.dim)) return null; // CV silent / field-only + soft requirement → omit
  return {
    type: 'education',
    canonical_name: 'education',
    dims: [best.dim],
    cv_status: 'missing',
    cv_level: null,
    required_level: jdRank,
    gap_levels: jdRank,
    importance: best.dim.importance,
    confidence: SILENCE_CONFIDENCE,
    from_silence: true,
  };
}

/** PURE: grade the JD's domain requirement by EXACT canonical overlap (no fuzzy/semantic). CV silent
 *  (no domain signal) is ALWAYS omitted — a missing domain is asserted only against an evidenced
 *  CV domain that differs. One collective GapItem per report (`jd:domain:domain`). */
export function gradeDomain(
  dims: JdDimension[] | null | undefined,
  signals: CvProfileSignals | null | undefined,
): DimensionGrade | null {
  // Keep ONLY the dims whose industry actually canonicalises — so `dims` (which drives the disclosure
  // `graded` flag) never marks a non-canonicalising domain quote as graded. classifyDomains runs once per dim.
  const canonicalising = (dims ?? [])
    .filter((d) => d.dimension === 'domain')
    .map((d) => ({ dim: d, domains: classifyDomains(`${d.value_text} ${d.evidence_text}`) }))
    .filter((x) => x.domains.length > 0);
  if (canonicalising.length === 0) return null; // JD industry not canonicalisable → can't grade
  const cv = signals?.domain ?? null;
  if (!cv) return null; // CV silent → always omit (honest)
  const jdDomains = [...new Set(canonicalising.flatMap((x) => x.domains))];
  const cvDomains = new Set(cv.domains);
  const matched = jdDomains.some((d) => cvDomains.has(d));
  const best = pickStrictest(canonicalising.map((x) => ({ dim: x.dim, rank: 0 })));
  return {
    type: 'domain',
    canonical_name: 'domain',
    dims: canonicalising.map((x) => x.dim),
    cv_status: matched ? 'matched' : 'missing',
    cv_level: null,
    required_level: null,
    gap_levels: matched ? 0 : 1,
    importance: best.dim.importance,
    confidence: confFromSignal(cv.confidence),
    from_silence: false,
  };
}

/** PURE: grade ALL non-skill dimensions with a CV-side signal (language/education/domain). work_mode is
 *  intentionally excluded (disclosure-only). Returns at most one grade per dimension type. */
export function gradeNonSkillDimensions(
  dims: JdDimension[] | null | undefined,
  signals: CvProfileSignals | null | undefined,
): DimensionGrade[] {
  return [
    gradeLanguage(dims, signals),
    gradeEducation(dims, signals),
    gradeDomain(dims, signals),
  ].filter((g): g is DimensionGrade => g !== null);
}
