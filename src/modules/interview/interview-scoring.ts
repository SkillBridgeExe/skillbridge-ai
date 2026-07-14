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

/** One LLM-scored answer (Call A output) tagged with the topic phase it was asked under. */
export interface AnswerScore {
  topic_phase: InterviewPhase;
  score: number; // 0..100, BARS-calibrated by Call A
  depth_signal: DepthSignal;
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
  let scored_answers = 0;
  for (const a of input.answers) {
    const dims = topicDimensions(a.topic_phase);
    if (dims.length === 0) continue;
    scored_answers += 1;
    const w = DEPTH_WEIGHT[a.depth_signal] ?? 0.5;
    for (const d of dims) {
      const e = acc.get(d) ?? { wsum: 0, wscore: 0 };
      e.wsum += w;
      e.wscore += w * a.score;
      acc.set(d, e);
    }
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

  return { overall, overall_band: band(overall), dimensions, role_family, scored_answers };
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
