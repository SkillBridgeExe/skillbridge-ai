/**
 * Unified Gap Engine v2 — FOUNDATION (PR1) + SEVERITY FORMULA (PR2).
 *
 * One canonical "gap object" that every CV-analysis flow can speak. This file is the central
 * CONTRACT: a deterministic `GapItem` type + a PURE `buildGapItems()` that UNIFIES signals that
 * already exist (SkillDiffService matched/partial/missing + the evidence ledger + optional market
 * demand) into a single list, plus `computeSeverity()` (PR2) that ranks them. No LLM, no
 * Date.now/random — same input → same output.
 *
 * Deferred to later PRs (see plan): JD-Intelligence requirement types beyond skills (PR3), the CV
 * Patch Engine consuming `fixability` (PR4), market hardening (PR5), folding market_implied gaps in,
 * and LLM prose for `recommended_next_action` (the current value is a deterministic label).
 */
import { EvidenceLedger } from '../../common/services/evidence-ledger';
import { Importance } from '../../common/services/role-rubric.service';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { MATCH_TUNING } from '../cv-jd-match/skill-diff.service';

export type GapSource = 'jd' | 'role_rubric' | 'market_implied';
export type GapType =
  | 'hard_skill'
  | 'soft_skill'
  | 'seniority'
  | 'language'
  | 'domain'
  | 'education'
  | 'work_mode';
export type GapImportance = Importance; // 'REQUIRED' | 'PREFERRED' | 'NICE_TO_HAVE'
export type CvStatus = 'matched' | 'partial' | 'missing' | 'unproven' | 'overclaimed';
export type EvidenceRisk = 'none' | 'listed_only' | 'unproven';
export type Fixability = 'rewrite' | 'add_evidence' | 'learn' | 'not_fixable_now';

export interface GapItem {
  /** STABLE id `${source}:${type}:${canonical_name}` — lets downstream dedupe + track a gap across re-grades. */
  requirement_id: string;
  source: GapSource;
  /** PR1 emits hard_skill/soft_skill only; JD-Intelligence v2 (PR3) adds the rest. */
  type: GapType;
  canonical_name: string;
  display_name: string;
  importance: GapImportance;
  cv_status: CvStatus;
  cv_level: number | null;
  required_level: number | null;
  /** max(0, required_level - cv_level). */
  gap_levels: number;
  /** Child skill that satisfied the requirement via a satisfies-edge (skill-diff). */
  satisfied_by: string | null;
  /** Where in the CV this skill is evidenced (ledger source refs). */
  evidence_refs: string[];
  evidence_risk: EvidenceRisk;
  fixability: Fixability;
  /** pct_of_postings (0-100) when market data is supplied; null otherwise (PR1 default). */
  market_demand: number | null;
  /** 0-1 ranking score from computeSeverity() (PR2): clamp01(importance × core × marketMult),
   *  core = 0.65·max(level,evidence) + 0.35·interview_risk. Deterministic; matched+proven = 0. */
  severity: number;
  /** 0-1. 1.0 for deterministic skill-diff items; lower reserved for market_implied (PR3+). */
  confidence: number;
  /** Deterministic short label (PR1). LLM prose is a later PR. '' when no action (a strength). */
  recommended_next_action: string;
}

export interface BuildGapItemsInput {
  match: CvJdMatchParsedResponse;
  ledger?: EvidenceLedger | null;
  /** canonical_name → pct_of_postings (0-100). Optional; PR1 callers may omit. */
  marketDemand?: Map<string, number> | null;
}

const importanceWeight = (importance: GapImportance): number =>
  MATCH_TUNING.importanceMultiplier[importance] ?? 0.3;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ── Severity formula (PR2) ───────────────────────────────────────────────────────────────────
// severity = clamp01( imp × core × marketMult ), pure + deterministic. Reconciles three design
// lenses (learner-ROI / screening-risk / market-signal). The owner's stated 5-way product
// (importance × gap × market × evidence × interview) is kept in SHAPE but NOT as a naive product:
// a product zeroes a gap whenever ANY factor is 0 (a level-met-but-unproven skill has gap_levels=0;
// ~38% of jobs have null market_demand). So gap+evidence+interview become an additive max-then-blend
// `core` that no single zero can annihilate, while importance (outer scaler) and market (neutral-
// centered multiplier) keep their multiplicative role — importance SHOULD shrink a NICE gap and
// market SHOULD tilt within a tier, but neither may crush a real gap to ~0.

/** "No proof" magnitude per evidence_risk — feeds both the need-blend and the interview amplifier. */
const EVIDENCE_RISK_W: Record<EvidenceRisk, number> = { none: 0, listed_only: 0.45, unproven: 0.7 };
/** Interview-probe danger by cv_status (importance-free). missing is LOW: you can't be grilled on a
 *  skill you never claimed — that danger lives in the level/need channel, not the interview channel. */
const STATUS_BASE_IV: Record<CvStatus, number> = {
  matched: 0,
  missing: 0.1,
  partial: 0.45,
  unproven: 0.8,
  overclaimed: 1.0,
};
const MARKET_NEUTRAL = 0.5; // null market_demand → marketMult 1.0 (identity), never a kill-switch
const NEED_W = 0.65; // "is the gap real" channel weight in core
const IV_W = 0.35; // interview-probe channel weight in core
const MARKET_FLOOR = 0.8; // marketMult ∈ [0.8, 1.2]; floor reached only at a REAL 0% demand
const MARKET_SPAN = 0.4;

/** interview_risk (NET-NEW, importance-free, [0,1]) derived ONLY from cv_status + evidence_risk:
 *  P(this gap is probed and the candidate is exposed in the interview). An overclaimed/unproven
 *  claim is the classic "walk me through that" trap; thinner proof raises it. matched+none → 0. */
export function interviewRiskRaw(item: Pick<GapItem, 'cv_status' | 'evidence_risk'>): number {
  const base = STATUS_BASE_IV[item.cv_status] ?? 0;
  const ev = EVIDENCE_RISK_W[item.evidence_risk] ?? 0;
  return clamp01(base * (0.5 + 0.5 * ev));
}

type SeverityInput = Pick<
  GapItem,
  'importance' | 'gap_levels' | 'evidence_risk' | 'cv_status' | 'market_demand'
>;

/** UNROUNDED severity — the internal RANKING value. PURE, deterministic, clamped [0,1] but NOT
 *  rounded. Ordering must use THIS, never the rounded public `severity`: two gaps differing only
 *  slightly (e.g. market_demand 53 vs 50) round to the same 3dp public value yet must still order by
 *  their true magnitude. The public `computeSeverity()` is just round3 of this. */
export function severityRaw(item: SeverityInput): number {
  const imp = importanceWeight(item.importance);
  const levelPart = clamp01((item.gap_levels ?? 0) / 5);
  const evPart = EVIDENCE_RISK_W[item.evidence_risk] ?? 0;
  const need = Math.max(levelPart, evPart); // never zeroed by gap_levels=0 — evidence carries it
  const core = NEED_W * need + IV_W * interviewRiskRaw(item);
  const fMarket = item.market_demand == null ? MARKET_NEUTRAL : clamp01(item.market_demand / 100);
  const marketMult = MARKET_FLOOR + MARKET_SPAN * fMarket; // [0.8,1.2]; null → 1.0
  return clamp01(imp * core * marketMult);
}

/** PUBLIC severity — severityRaw() rounded to 3dp (platform-stable golden values), stored on
 *  GapItem.severity. Ranking uses severityRaw() so near-ties don't collapse. */
export function computeSeverity(item: SeverityInput): number {
  return round3(severityRaw(item));
}

const ACTION_LABEL: Record<CvStatus, string> = {
  missing: 'Học & bổ sung kỹ năng này',
  partial: 'Nâng trình độ và làm rõ bằng chứng',
  unproven: 'Thêm 1 bullet chứng minh (hiện chỉ liệt kê)',
  overclaimed: 'Bổ sung bằng chứng cho mức đã khai',
  matched: '',
};

const typeOf = (skillType?: 'hard' | 'soft'): GapType =>
  skillType === 'soft' ? 'soft_skill' : 'hard_skill';

/**
 * Deterministic unification of the existing diff + ledger (+ optional market) into GapItem[].
 * One item per REQUIREMENT (matched/partial/missing); bonus_skills are extras, not requirements,
 * so they are excluded here.
 *
 * SCOPE (PR1): emits JD/rubric REQUIREMENTS only. `market_implied` gaps (skills the market expects
 * that the CV lacks) still live separately in gap-report's `market_trend_gaps` — folding them into
 * gap_items is a later PR. So this is the unification FOUNDATION, not yet the single source for
 * every gap type.
 */
export function buildGapItems(input: BuildGapItemsInput): GapItem[] {
  const { match, ledger, marketDemand } = input;
  const source: GapSource = match.source_of_requirements === 'jd_extraction' ? 'jd' : 'role_rubric';

  const evidenceGap = new Set(ledger?.evidence_gap ?? []);
  const strengthByCanonical = new Map(
    (ledger?.items ?? []).map((i) => [i.skill_canonical, i.strength] as const),
  );
  const refsByCanonical = new Map(
    (ledger?.items ?? []).map((i) => [i.skill_canonical, i.sources.map((s) => s.ref)] as const),
  );

  const base = (
    canonical: string,
    displayName: string,
    importance: GapImportance,
    type: GapType,
  ) => ({
    // Report-SCOPED id — unique within one gap report, enough to dedupe/key the UI. NOT globally
    // unique across JD/role/band: typescript@frontend-L4 and typescript@fullstack-L3 collide.
    // When history/analytics tracks a gap across re-grades, add a context id (match_id/role/band).
    requirement_id: `${source}:${type}:${canonical}`,
    source,
    type,
    canonical_name: canonical,
    display_name: displayName,
    importance,
    satisfied_by: null as string | null,
    evidence_refs: refsByCanonical.get(canonical) ?? [],
    market_demand: marketDemand?.get(canonical) ?? null,
    confidence: 1,
  });

  const items: GapItem[] = [];

  for (const m of match.missing_skills) {
    const evidence_risk: EvidenceRisk = 'none';
    items.push({
      ...base(m.canonical_name, m.display_name, m.importance, typeOf(m.skill_type)),
      cv_status: 'missing',
      cv_level: null,
      required_level: m.required_level,
      gap_levels: m.gap_levels,
      evidence_risk,
      fixability: 'learn',
      severity: computeSeverity({
        importance: m.importance,
        gap_levels: m.gap_levels,
        evidence_risk,
        cv_status: 'missing',
        market_demand: marketDemand?.get(m.canonical_name) ?? null,
      }),
      recommended_next_action: ACTION_LABEL.missing,
    });
  }

  for (const p of match.partial_skills) {
    const strength = strengthByCanonical.get(p.canonical_name);
    const listedOnly = evidenceGap.has(p.canonical_name) || strength === 'listed_only';
    const demonstrated = strength === 'demonstrated';
    // A skill claimed at >= advanced (cv_level>=4) but only listed (no demonstrated evidence) is an
    // OVERCLAIM even when it sits in partial_skills because the JD wants an even higher level
    // (e.g. claims ADVANCED, JD needs EXPERT). The overclaim is the dominant signal — downstream
    // interview probing asks "how did you prove that advanced level?" — so it wins over the
    // level-gap framing. The level gap is still recorded in gap_levels.
    const overclaimed = listedOnly && p.cv_level >= 4;
    const cv_status: CvStatus = overclaimed ? 'overclaimed' : 'partial';
    const evidence_risk: EvidenceRisk = overclaimed
      ? 'unproven'
      : listedOnly
        ? 'listed_only'
        : 'none';
    items.push({
      ...base(p.canonical_name, p.display_name, p.importance, typeOf(p.skill_type)),
      satisfied_by: p.satisfied_by ?? null,
      cv_status,
      cv_level: p.cv_level,
      required_level: p.required_level,
      gap_levels: p.gap_levels,
      evidence_risk,
      // Overclaim → prove it (add evidence); demonstrated → a rewrite can foreground it;
      // otherwise the level itself must grow.
      fixability: overclaimed ? 'add_evidence' : demonstrated ? 'rewrite' : 'learn',
      severity: computeSeverity({
        importance: p.importance,
        gap_levels: p.gap_levels,
        evidence_risk,
        cv_status,
        market_demand: marketDemand?.get(p.canonical_name) ?? null,
      }),
      recommended_next_action: ACTION_LABEL[cv_status],
    });
  }

  for (const mt of match.matched_skills) {
    const strength = strengthByCanonical.get(mt.canonical_name);
    const listedOnly = evidenceGap.has(mt.canonical_name) || strength === 'listed_only';
    const overclaimed = listedOnly && mt.cv_level >= 4;
    const cv_status: CvStatus = overclaimed ? 'overclaimed' : listedOnly ? 'unproven' : 'matched';
    const evidence_risk: EvidenceRisk = overclaimed
      ? 'unproven'
      : listedOnly
        ? 'listed_only'
        : 'none';
    items.push({
      ...base(mt.canonical_name, mt.display_name, mt.importance, typeOf(mt.skill_type)),
      satisfied_by: mt.satisfied_by ?? null,
      cv_status,
      cv_level: mt.cv_level,
      required_level: mt.required_level,
      gap_levels: 0,
      evidence_risk,
      fixability: cv_status === 'matched' ? 'not_fixable_now' : 'add_evidence',
      severity: computeSeverity({
        importance: mt.importance,
        gap_levels: 0,
        evidence_risk,
        cv_status,
        market_demand: marketDemand?.get(mt.canonical_name) ?? null,
      }),
      recommended_next_action: ACTION_LABEL[cv_status],
    });
  }

  // Highest severity first. Rank by the UNROUNDED raw severity (not the rounded public `severity`)
  // so two gaps that round to the same 3dp value still order by their true magnitude — e.g. a
  // market_demand 53 gap outranks an otherwise-identical 50 gap though both publish as 0.063. The
  // public GapItem.severity stays round3. Stable tiebreak by canonical keeps output reproducible.
  return items
    .map((item) => ({ item, raw: severityRaw(item) }))
    .sort((a, b) => b.raw - a.raw || a.item.canonical_name.localeCompare(b.item.canonical_name))
    .map((entry) => entry.item);
}
