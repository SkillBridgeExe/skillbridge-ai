import { maskPii } from '../../common/services/pii-mask';
import { DepthSignal, EARLY_CAREER_BANDS, InterviewPhase } from './interview-agenda';

export type Dimension =
  | 'technical_depth'
  | 'problem_solving'
  | 'communication'
  | 'evidence_credibility'
  | 'role_fit';

export type RoleFamily =
  | 'ic_eng'
  | 'data_ai_ml'
  | 'devops_sre'
  | 'qa'
  | 'lead_manager'
  | 'fresher_intern';

export type ScoreBand = 'poor' | 'borderline' | 'solid' | 'outstanding';

export const INTERVIEW_CRITERION_KEYS = [
  'correctness',
  'depth',
  'application',
  'relevance',
  'diagnosis',
  'reasoning',
  'tradeoffs',
  'structure',
  'clarity',
  'concision',
  'evidence',
  'specificity',
  'consistency',
  'ownership',
  'scope',
  'seniority_fit',
] as const;

export type InterviewCriterionKey = (typeof INTERVIEW_CRITERION_KEYS)[number];

export interface InterviewCriterionScore {
  key: InterviewCriterionKey;
  /** 0..4 rubric level. The model never emits the final 0..100 score. */
  score: number;
  /** Short answer-grounded reason, never raw CV/JD content. */
  evidence?: string;
}

export type InterviewScoreSource = 'criterion_rubric' | 'legacy_llm' | 'unscored';
export type CriterionCoverage = 'complete' | 'partial' | 'missing';
export type InterviewScoreBasis = 'criterion_rubric' | 'legacy_fallback' | 'mixed' | 'unscored';

type CriterionWeight = Readonly<{
  key: InterviewCriterionKey;
  weight: number;
}>;

const DIMENSION_CRITERIA: Record<Dimension, readonly CriterionWeight[]> = {
  technical_depth: [
    { key: 'correctness', weight: 0.45 },
    { key: 'depth', weight: 0.3 },
    { key: 'application', weight: 0.15 },
    { key: 'relevance', weight: 0.1 },
  ],
  problem_solving: [
    { key: 'diagnosis', weight: 0.3 },
    { key: 'reasoning', weight: 0.3 },
    { key: 'tradeoffs', weight: 0.25 },
    { key: 'application', weight: 0.15 },
  ],
  communication: [
    { key: 'structure', weight: 0.4 },
    { key: 'clarity', weight: 0.35 },
    { key: 'concision', weight: 0.25 },
  ],
  evidence_credibility: [
    { key: 'evidence', weight: 0.5 },
    { key: 'specificity', weight: 0.3 },
    { key: 'consistency', weight: 0.2 },
  ],
  role_fit: [
    { key: 'ownership', weight: 0.35 },
    { key: 'scope', weight: 0.3 },
    { key: 'seniority_fit', weight: 0.35 },
  ],
};

export function criterionKeysForDimension(dimension: Dimension): InterviewCriterionKey[] {
  return DIMENSION_CRITERIA[dimension].map(({ key }) => key);
}

export interface CalibratedAnswerScore {
  score: number | null;
  source: InterviewScoreSource;
  criteriaCoverage: CriterionCoverage;
  confidence: ScoreUncertainty;
  missingCriteria: InterviewCriterionKey[];
  reasons: string[];
  criteria: InterviewCriterionScore[];
}

export type CalibratedAnswerScores = Partial<Record<Dimension, CalibratedAnswerScore>>;

/**
 * Role-weighted rubric (spec §2, approved 06-19). Each row sums to 100; HELD IN CODE, never the LLM.
 * Resolved from the CV-JD match's target role-family + seniority band.
 */
export const ROLE_RUBRIC_WEIGHTS: Record<RoleFamily, Record<Dimension, number>> = {
  ic_eng: {
    technical_depth: 40,
    problem_solving: 25,
    communication: 12,
    evidence_credibility: 15,
    role_fit: 8,
  },
  data_ai_ml: {
    technical_depth: 40,
    problem_solving: 30,
    communication: 12,
    evidence_credibility: 13,
    role_fit: 5,
  },
  devops_sre: {
    technical_depth: 35,
    problem_solving: 30,
    communication: 13,
    evidence_credibility: 12,
    role_fit: 10,
  },
  qa: {
    technical_depth: 30,
    problem_solving: 25,
    communication: 20,
    evidence_credibility: 15,
    role_fit: 10,
  },
  lead_manager: {
    technical_depth: 25,
    problem_solving: 15,
    communication: 30,
    evidence_credibility: 10,
    role_fit: 20,
  },
  fresher_intern: {
    technical_depth: 35,
    problem_solving: 25,
    communication: 20,
    evidence_credibility: 5,
    role_fit: 15,
  },
};

// Keyword → role-family (checked in order; first hit wins). Mirrors the taxonomy's role families.
const FAMILY_KEYWORDS: Array<{ family: RoleFamily; terms: string[] }> = [
  { family: 'lead_manager', terms: ['manager', 'lead', 'principal', 'staff', 'head', 'director'] },
  { family: 'data_ai_ml', terms: ['data', 'ai', 'ml', 'machine', 'scientist', 'analyst'] },
  { family: 'devops_sre', terms: ['devops', 'sre', 'platform', 'infra', 'reliability'] },
  { family: 'qa', terms: ['qa', 'test', 'quality', 'sdet'] },
  {
    family: 'ic_eng',
    terms: ['frontend', 'backend', 'fullstack', 'mobile', 'software', 'developer', 'engineer'],
  },
];

/**
 * Resolve the rubric column. fresher/intern seniority → fresher_intern (low evidence weight); otherwise
 * keyword-match the role string to a family, defaulting to ic_eng. Deterministic.
 */
export function resolveRoleFamily(role: string, seniority: string): RoleFamily {
  if (EARLY_CAREER_BANDS.has(seniority.trim().toLowerCase())) return 'fresher_intern';
  const r = role.toLowerCase();
  for (const { family, terms } of FAMILY_KEYWORDS) {
    if (terms.some((t) => r.includes(t))) return family;
  }
  return 'ic_eng';
}

/** One calibrated answer tagged with the topic phase it was asked under. */
export interface AnswerScore {
  topic_phase: InterviewPhase;
  score: number; // 0..100, derived by code or explicit legacy fallback
  depth_signal: DepthSignal;
  score_source?: InterviewScoreSource;
  /** Per-dimension scores for topics that intentionally measure more than one dimension. */
  dimension_scores?: Partial<Record<Dimension, number | null>>;
  dimension_score_sources?: Partial<Record<Dimension, InterviewScoreSource>>;
}

export interface DimensionResult {
  dimension: Dimension;
  score: number; // 0..100 depth-weighted mean
  band: ScoreBand;
  weight: number; // the role-family weight applied to this dimension
}

export interface InterviewScore {
  overall: number; // 0..100, role-weighted mean over scored dimensions
  overall_band: ScoreBand;
  dimensions: DimensionResult[]; // only dimensions with >=1 answer
  role_family: RoleFamily;
  scored_answers: number; // answers that mapped to >=1 dimension (excludes SCREENING/WRAP)
  /** Present when answer-level provenance was available; omitted for legacy pure-function callers. */
  score_basis?: InterviewScoreBasis;
}

const TOPIC_DIMENSIONS: Record<InterviewPhase, Dimension[]> = {
  SCREENING: [],
  SKILL_PROBE: ['technical_depth', 'evidence_credibility'],
  JD_REQUIREMENT: ['technical_depth', 'evidence_credibility'],
  SCENARIO: ['problem_solving'],
  BEHAVIORAL: ['communication', 'role_fit'],
  WRAP: [],
};

// Deeper answers carry more signal than hand-wavy ones (spec §4 "depth-weighted mean").
const DEPTH_WEIGHT: Record<DepthSignal, number> = {
  deep: 1.0,
  adequate: 0.75,
  shallow: 0.5,
  evasive: 0.3,
};

function validCriterionScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 4
  );
}

/**
 * Calibrate one answer from the dimension rubric. The final 0..100 number is code-owned:
 * criterion scores are weighted by the dimension rubric, then passed through the existing
 * consistency caps. An incomplete rubric is deliberately unscored instead of being filled with
 * a plausible-looking number. Legacy sessions may use the explicit low-confidence fallback.
 */
export function calibrateInterviewAnswerScore(input: {
  dimension: Dimension;
  criteria: InterviewCriterionScore[];
  legacyScore?: number | null;
  depthSignal: DepthSignal;
  offTopic: boolean;
  claimStatus?: 'ok' | 'partial' | 'wrong';
}): CalibratedAnswerScore {
  const required = DIMENSION_CRITERIA[input.dimension];
  const normalized = input.criteria.filter(
    (criterion): criterion is InterviewCriterionScore =>
      required.some(({ key }) => key === criterion.key) && validCriterionScore(criterion.score),
  );
  const byKey = new Map(normalized.map((criterion) => [criterion.key, criterion]));
  const missingCriteria = required.filter(({ key }) => !byKey.has(key)).map(({ key }) => key);

  if (missingCriteria.length > 0) {
    const criteriaCoverage: CriterionCoverage = byKey.size > 0 ? 'partial' : 'missing';
    if (
      byKey.size === 0 &&
      typeof input.legacyScore === 'number' &&
      Number.isFinite(input.legacyScore)
    ) {
      const reconciled = reconcileAnswerScore({
        score: Math.max(0, Math.min(100, Math.round(input.legacyScore))),
        depth_signal: input.depthSignal,
        off_topic: input.offTopic,
      });
      return {
        score: reconciled.score,
        source: 'legacy_llm',
        criteriaCoverage: 'missing',
        confidence: 'low',
        missingCriteria,
        reasons: ['legacy_score_fallback', ...reconciled.reasons],
        criteria: [],
      };
    }

    return {
      score: null,
      source: 'unscored',
      criteriaCoverage,
      confidence: 'low',
      missingCriteria,
      reasons: ['criteria_incomplete'],
      criteria: normalized,
    };
  }

  const weightedScore = required.reduce(
    (sum, { key, weight }) => sum + (byKey.get(key)?.score ?? 0) * weight,
    0,
  );
  const rawScore = Math.round((weightedScore / 4) * 100);
  const reconciled = reconcileAnswerScore({
    score: rawScore,
    depth_signal: input.depthSignal,
    off_topic: input.offTopic,
  });
  const reasons = [...reconciled.reasons];
  let score = reconciled.score;
  if (input.claimStatus === 'wrong' && score > 40) {
    score = 40;
    reasons.push('score_capped_wrong_claim');
  }

  return {
    score,
    source: 'criterion_rubric',
    criteriaCoverage: 'complete',
    confidence: normalized.every((criterion) => Boolean(criterion.evidence?.trim()))
      ? 'high'
      : 'medium',
    missingCriteria: [],
    reasons,
    criteria: normalized,
  };
}

/**
 * Calibrate every dimension attached to a topic independently. A SKILL_PROBE, for example,
 * measures both technical depth and evidence credibility; reusing the first dimension's score for
 * both would make the second dimension look assessed when it was never judged.
 */
export function calibrateInterviewAnswerScores(input: {
  dimensions: Dimension[];
  criteria: InterviewCriterionScore[];
  legacyScore?: number | null;
  depthSignal: DepthSignal;
  offTopic: boolean;
  claimStatus?: 'ok' | 'partial' | 'wrong';
}): CalibratedAnswerScores {
  const uniqueDimensions = [...new Set(input.dimensions)];
  return Object.fromEntries(
    uniqueDimensions.map((dimension) => [
      dimension,
      calibrateInterviewAnswerScore({
        dimension,
        criteria: input.criteria,
        legacyScore: input.legacyScore,
        depthSignal: input.depthSignal,
        offTopic: input.offTopic,
        claimStatus: input.claimStatus,
      }),
    ]),
  ) as CalibratedAnswerScores;
}

/** Dimensions a topic phase contributes to (spec §4). SCREENING/WRAP → none. */
export function topicDimensions(phase: InterviewPhase): Dimension[] {
  return TOPIC_DIMENSIONS[phase] ?? [];
}

/** BARS band (spec §3): <=40 poor · <=60 borderline · <=80 solid · else outstanding. */
export function band(score: number): ScoreBand {
  if (score <= 40) return 'poor';
  if (score <= 60) return 'borderline';
  if (score <= 80) return 'solid';
  return 'outstanding';
}

const DIMS: Dimension[] = [
  'technical_depth',
  'problem_solving',
  'communication',
  'evidence_credibility',
  'role_fit',
];

/**
 * Deterministic role-weighted aggregation (spec §4). Each answer feeds every dimension its phase maps to;
 * a dimension's score is the depth-weighted mean of its answers. The overall is the role-weighted mean over
 * ONLY the dimensions that actually have answers (renormalized) — never penalize for a dimension the
 * interview didn't probe. SCREENING/WRAP are excluded. The LLM never sees the weights.
 */
export function aggregateInterviewScore(input: {
  answers: AnswerScore[];
  role: string;
  seniority: string;
}): InterviewScore {
  const role_family = resolveRoleFamily(input.role, input.seniority);
  const weights = ROLE_RUBRIC_WEIGHTS[role_family];

  const acc = new Map<Dimension, { wsum: number; wscore: number }>();
  const scoreSources = new Set<InterviewScoreSource>();
  let scored_answers = 0;
  for (const a of input.answers) {
    const dims = topicDimensions(a.topic_phase);
    if (dims.length === 0) continue;
    const w = DEPTH_WEIGHT[a.depth_signal] ?? 0.5;
    let answerWasScored = false;
    for (const d of dims) {
      const dimensionScore = a.dimension_scores?.[d] ?? a.score;
      if (typeof dimensionScore !== 'number' || !Number.isFinite(dimensionScore)) continue;
      answerWasScored = true;
      const source = a.dimension_score_sources?.[d] ?? a.score_source;
      if (source) scoreSources.add(source);
      const e = acc.get(d) ?? { wsum: 0, wscore: 0 };
      e.wsum += w;
      e.wscore += w * dimensionScore;
      acc.set(d, e);
    }
    if (answerWasScored) scored_answers += 1;
  }

  const dimensions: DimensionResult[] = DIMS.filter((d) => acc.has(d) && acc.get(d)!.wsum > 0).map(
    (d) => {
      const e = acc.get(d)!;
      const score = Math.round(e.wscore / e.wsum);
      return { dimension: d, score, band: band(score), weight: weights[d] };
    },
  );

  if (dimensions.length === 0) {
    return { overall: 0, overall_band: band(0), dimensions: [], role_family, scored_answers: 0 };
  }

  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
  const overall = Math.round(
    dimensions.reduce((s, d) => s + d.score * d.weight, 0) / (totalWeight || 1),
  );

  const score_basis = scoreSources.size
    ? scoreSources.has('criterion_rubric') && scoreSources.has('legacy_llm')
      ? 'mixed'
      : scoreSources.has('criterion_rubric')
        ? 'criterion_rubric'
        : scoreSources.has('legacy_llm')
          ? 'legacy_fallback'
          : 'unscored'
    : undefined;

  return {
    overall,
    overall_band: band(overall),
    dimensions,
    role_family,
    scored_answers,
    ...(score_basis ? { score_basis } : {}),
  };
}

// ---------------------------------------------------------------------------
// Wave I-CONSIST — depth-vs-score consistency guard
// ---------------------------------------------------------------------------

/**
 * Band-aligned ceilings for LLM self-contradictions (Call A gives score AND depth_signal in one
 * pass; off_topic comes from the independent L2 judge). A contradiction is capped, never re-scored:
 *  - off_topic → poor ceiling: an answer that did not address THIS question cannot score above poor
 *    on it, whatever its content quality;
 *  - evasive → borderline ceiling (not poor: depth-weighting already discounts evasive ×0.3, and a
 *    partially-evasive answer can still be partially right);
 *  - shallow → solid ceiling: the outstanding anchor REQUIRES depth/trade-offs, so shallow+81+ is
 *    a contradiction by the rubric's own definition.
 */
export const OFF_TOPIC_SCORE_CAP = 40;
export const EVASIVE_SCORE_CAP = 60;
export const SHALLOW_SCORE_CAP = 80;

export interface ScoreReconciliation {
  /** the score production consumes (capped when contradictory). */
  score: number;
  raw_score: number;
  capped: boolean;
  /** compact trace slugs, same channel as InterviewTurnTrace.reasons. */
  reasons: string[];
}

/**
 * Deterministic consistency guard between the LLM's own judgments. Cap-only (never raises a
 * score), applied at the single chokepoint where a per-answer score enters persistence — so
 * aggregation, explanations, and coaching all see the reconciled value.
 */
export function reconcileAnswerScore(input: {
  score: number;
  depth_signal: DepthSignal;
  off_topic: boolean;
}): ScoreReconciliation {
  const caps: Array<{ cap: number; reason: string }> = [];
  if (input.off_topic) caps.push({ cap: OFF_TOPIC_SCORE_CAP, reason: 'score_capped_off_topic' });
  if (input.depth_signal === 'evasive') {
    caps.push({ cap: EVASIVE_SCORE_CAP, reason: 'score_capped_evasive' });
  }
  if (input.depth_signal === 'shallow') {
    caps.push({ cap: SHALLOW_SCORE_CAP, reason: 'score_capped_shallow' });
  }
  const fired = caps.filter((c) => input.score > c.cap);
  const score = fired.reduce((s, c) => Math.min(s, c.cap), input.score);
  return {
    score,
    raw_score: input.score,
    capped: fired.length > 0,
    reasons: fired.map((c) => c.reason),
  };
}

export interface DepthReconciliation {
  /** the depth signal production consumes (downgraded when contradictory). */
  depth_signal: DepthSignal;
  downgraded: boolean;
  /** compact trace slugs, same channel as InterviewTurnTrace.reasons. */
  reasons: string[];
}

/**
 * Depth guard (I-CONSIST-2): a "deep" label on a too-short answer (<20 words, L1-counted) is a
 * contradiction — the outstanding/deep bar requires trade-offs and substance a 20-word answer
 * cannot carry. Downgrade to 'adequate' so a suspect deep neither earns the 1.0 aggregation
 * weight nor triggers push_harder drilling. Single tight rule on purpose: length is the only
 * L1 signal that can safely refute depth (a crisp 25-word answer without an example CAN be deep).
 */
export function reconcileDepthSignal(input: {
  depth_signal: DepthSignal;
  is_too_short: boolean;
}): DepthReconciliation {
  if (input.depth_signal === 'deep' && input.is_too_short) {
    return {
      depth_signal: 'adequate',
      downgraded: true,
      reasons: ['depth_downgraded_thin_answer'],
    };
  }
  return { depth_signal: input.depth_signal, downgraded: false, reasons: [] };
}

// ---------------------------------------------------------------------------
// Wave I-SCORE — evidence-based score explanation
// ---------------------------------------------------------------------------

/** an AnswerScore that can also carry the (raw) answer text + question link for evidence quotes. */
export interface AnswerEvidence extends AnswerScore {
  /** raw answer text — masked + truncated into evidence_quote here, never stored raw. */
  evidence_excerpt?: string;
  linked_question_id?: string;
}

export type ScoreUncertainty = 'low' | 'medium' | 'high';

export interface ScoreExplanation {
  dimension: Dimension;
  score: number;
  band: ScoreBand;
  weight: number;
  /** BARS band anchor + dimension lens — CODE-owned strings, mirrors interview_assess_v1. */
  rubric_anchor: string;
  /** strongest contributing answer, masked + truncated; null when no answer text exists. */
  evidence_quote: string | null;
  linked_question_id: string | null;
  uncertainty: ScoreUncertainty;
  /** set only for below-solid bands — honest, dimension-specific, never hiring-outcome language. */
  improvement_hint: string | null;
}

/** mirrors interview-gap.ts EVIDENCE_MAX. */
const EXPLANATION_EVIDENCE_MAX = 280;

/** BARS anchors (mirror interview_assess_v1's four levels — held in code, never the LLM). */
const BAND_ANCHORS: Record<ScoreBand, string> = {
  poor: 'poor (0-40): incorrect, evasive, or no real substance on this dimension',
  borderline: 'borderline (41-60): partially right but shallow or missing the key idea',
  solid: 'solid (61-80): correct and clear, real understanding appropriate to the level',
  outstanding:
    'outstanding (81-100): depth, trade-offs, edge cases, or judgement beyond the baseline',
};

const DIMENSION_LENS: Record<Dimension, string> = {
  technical_depth: 'accuracy and depth of the concept itself',
  problem_solving: 'reasoning, trade-offs, and how they approach or debug it',
  communication: 'clarity, structure, and concision',
  evidence_credibility: 'whether answers substantiate real CV claims with concrete substance',
  role_fit: 'whether demonstrated depth and ownership match the target seniority',
};

/** hints for below-solid bands only — communication signals, never psychological claims. */
const DIMENSION_HINTS: Record<Dimension, string> = {
  technical_depth: 'Re-study the core concept and practice explaining how it works under the hood.',
  problem_solving:
    'Practice walking through debugging steps out loud and naming the trade-off of each option.',
  communication: 'Structure answers (STAR for stories), lead with the point, and cut filler.',
  evidence_credibility:
    'Back each claim with one concrete project example and a measurable result.',
  role_fit: 'Bring ownership stories whose scope matches the target level.',
};

/** evidence mass (sum of depth weights) → base uncertainty; missing quote bumps one level. */
const UNCERTAINTY_LOW_MASS = 1.5;
const UNCERTAINTY_MEDIUM_MASS = 0.75;

function baseUncertainty(weightSum: number): ScoreUncertainty {
  if (weightSum >= UNCERTAINTY_LOW_MASS) return 'low';
  if (weightSum >= UNCERTAINTY_MEDIUM_MASS) return 'medium';
  return 'high';
}

function bumpUncertainty(value: ScoreUncertainty): ScoreUncertainty {
  return value === 'low' ? 'medium' : 'high';
}

/**
 * Deterministic per-dimension score explanation over the SAME aggregation the final score uses —
 * explanations can never disagree with the score because both come from one pass. The evidence
 * quote is the strongest contributing answer (highest depth weight, then score, then order),
 * masked + truncated. Uncertainty is evidence-mass-based and rises when no quotable text exists.
 */
export function explainInterviewScore(input: {
  answers: AnswerEvidence[];
  role: string;
  seniority: string;
}): { score: InterviewScore; explanations: ScoreExplanation[] } {
  const score = aggregateInterviewScore(input);

  const explanations = score.dimensions.map((d): ScoreExplanation => {
    const contributors = input.answers.filter((a) =>
      topicDimensions(a.topic_phase).includes(d.dimension),
    );
    const weightSum = contributors.reduce((s, a) => s + (DEPTH_WEIGHT[a.depth_signal] ?? 0.5), 0);
    const best = contributors.reduce<AnswerEvidence | null>((acc, a) => {
      if (!acc) return a;
      const wA = DEPTH_WEIGHT[a.depth_signal] ?? 0.5;
      const wAcc = DEPTH_WEIGHT[acc.depth_signal] ?? 0.5;
      if (wA > wAcc) return a;
      if (wA === wAcc && a.score > acc.score) return a;
      return acc;
    }, null);

    const rawQuote = best?.evidence_excerpt?.trim() ?? '';
    const evidence_quote = rawQuote ? maskPii(rawQuote).slice(0, EXPLANATION_EVIDENCE_MAX) : null;

    let uncertainty = baseUncertainty(weightSum);
    if (!evidence_quote) uncertainty = bumpUncertainty(uncertainty);

    const belowSolid = d.band === 'poor' || d.band === 'borderline';
    return {
      dimension: d.dimension,
      score: d.score,
      band: d.band,
      weight: d.weight,
      rubric_anchor: `${BAND_ANCHORS[d.band]} — ${d.dimension}: ${DIMENSION_LENS[d.dimension]}`,
      evidence_quote,
      linked_question_id: evidence_quote ? (best?.linked_question_id ?? null) : null,
      uncertainty,
      improvement_hint: belowSolid ? DIMENSION_HINTS[d.dimension] : null,
    };
  });

  return { score, explanations };
}
