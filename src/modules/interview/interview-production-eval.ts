import { analyzeAnswerSignals, AnswerSignals, Language } from './answer-analyzer';
import { AnswerInsight, groundAnswerInsight } from './answer-insight';
import { decideTurn, DepthSignal, InterviewPhase, TurnAction } from './interview-agenda';
import { InterviewGapItem, InterviewGapWeaknessType } from './interview-gap';
import { AnswerGapContext, deriveInterviewGaps } from './interview-gap-derive';
import { aggregateInterviewScore, AnswerScore } from './interview-scoring';

/**
 * Interview Production Eval — Wave I-TRUST: `scoreInterviewProductionCase`.
 *
 * A PURE, deterministic END-TO-END case scorer that composes the existing interview pieces —
 * `analyzeAnswerSignals` (L1) → `groundAnswerInsight` (L2 grounding) → `decideTurn` (follow-up
 * appropriateness) → `deriveInterviewGaps` (gap derivation) → `aggregateInterviewScore` (banding)
 * — over one golden corpus case. No LLM, no IO, no NestJS DI: the LLM-owned judgments
 * (depth_signal, per-answer BARS score, L2 nuance) are LABELED inputs in the corpus, exactly like
 * `interview-eval.ts`/`interview-gap-derive-eval.ts`; everything code-owned is computed for real.
 *
 * Gates covered (plan 2026-07-12 Wave I-TRUST Task 2):
 *  - expected decision action matches (or is in the accepted set),
 *  - labeled per-turn score sits in its band + aggregated overall sits in the case band,
 *  - every required final gap is emitted (subset) and no forbidden gap appears,
 *  - engine-side narration (gap recommended_action + insight note) carries NO forbidden claim —
 *    candidate quotes (evidence_from_answer) are deliberately NOT scanned,
 *  - locale is respected: L1 runs with the case locale; invalid locale fails the case.
 */

// ---------------------------------------------------------------------------
// Case shape (mirrors the design spec §8, additive fields for decision state)
// ---------------------------------------------------------------------------

export interface ProductionTurnCase {
  question: string;
  answer: string;
  topic_phase: InterviewPhase;
  skill_canonical?: string | null;
  display_name: string;
  jd_terms?: string[];
  /** labeled LLM judgment (Call A) — input to decideTurn, never computed here. */
  depth_signal: DepthSignal;
  /** labeled BARS per-answer score 0..100 (Call A) — input to aggregation. */
  score: number;
  /** raw L2 model output to ground; absent → deterministic safe fallback. */
  model_output?: unknown;
  /** optional override pinning grounded insight fields (e.g. evidence_quality). */
  insight?: Partial<AnswerInsight>;
  /** decision state at this turn (what interviews.service would hold in InterviewState). */
  drill_depth: number;
  drill_budget: number;
  evasive_streak?: number;
  /** defaults to the turn index — override to model a mid/late-interview state. */
  turns_used?: number;
  expected_decision: TurnAction;
  /** extra decisions accepted besides expected_decision. */
  accept_decisions?: TurnAction[];
  expected_flags?: ProductionFlag[];
  forbidden_flags?: ProductionFlag[];
  /** inclusive sanity band for the labeled score — catches mislabeled corpus. */
  expected_score_band?: [number, number];
}

export interface GapExpectation {
  weakness_type: InterviewGapWeaknessType;
  /** omit = any skill; null = must be the null-skill item (communication/behavioral). */
  skill_canonical?: string | null;
}

export interface InterviewProductionCase {
  id: string;
  locale: Language;
  target_role: string;
  seniority: string;
  cv_summary: string;
  jd_summary: string;
  turn_budget: number;
  turns: ProductionTurnCase[];
  /** required subset — every listed gap must be emitted (extras are allowed). */
  expected_final_gaps: GapExpectation[];
  /** gaps that must NOT be emitted (e.g. a clean STAR answer must not carry behavioral_gap). */
  forbidden_gaps?: GapExpectation[];
  /** case-specific forbidden claims, scanned on top of GLOBAL_FORBIDDEN_CLAIMS. */
  forbidden_claims?: string[];
  /** inclusive band for the aggregated overall score. */
  expected_overall_band?: [number, number];
}

export interface InterviewProductionResult {
  id: string;
  pass: boolean;
  overall: number;
  mismatches: string[];
}

// ---------------------------------------------------------------------------
// Deterministic flag checks (L1-signal predicates; names are the corpus contract)
// ---------------------------------------------------------------------------

export type ProductionFlag =
  | 'too_short'
  | 'missing_example'
  | 'rambling_risk'
  | 'quantified'
  | 'star_complete'
  | 'star_missing_result'
  | 'filler_high'
  | 'hedging_present'
  | 'jd_coverage_low';

/** mirrors interview-gap-derive's FILLER_THRESHOLD — 4+ fillers is a fired signal. */
const FILLER_HIGH = 4;
/** mirrors interview-gap-derive's COVERAGE_FLOOR. */
const COVERAGE_LOW = 0.5;

const FLAG_CHECKS: Record<ProductionFlag, (s: AnswerSignals) => boolean> = {
  too_short: (s) => s.flags.is_too_short,
  missing_example: (s) => s.flags.no_concrete_example,
  rambling_risk: (s) => s.flags.rambling_risk,
  quantified: (s) => s.is_quantified,
  star_complete: (s) => s.star.complete,
  star_missing_result: (s) => !s.star.result,
  filler_high: (s) => s.filler.count >= FILLER_HIGH,
  hedging_present: (s) => s.hedging.count >= 1,
  jd_coverage_low: (s) => s.jd_term_hits.coverage < COVERAGE_LOW,
};

// ---------------------------------------------------------------------------
// Forbidden claims — unsupported psychological / hiring-outcome language that the
// engine must NEVER emit in its own narration (spec §3.8, §5). Scanned as
// case-insensitive substrings over ENGINE text only (recommended_action + note).
// ---------------------------------------------------------------------------

export const GLOBAL_FORBIDDEN_CLAIMS: readonly string[] = [
  'you will get hired',
  'you will not get hired',
  "you won't get hired",
  'guaranteed to get hired',
  'unemployable',
  'personality',
  'chắc chắn đậu',
  'chắc chắn trượt',
  'sẽ không được tuyển',
  'tính cách',
];

const VALID_LOCALES: ReadonlySet<string> = new Set<Language>(['vi', 'en']);

const inBand = (value: number, band: [number, number]): boolean =>
  value >= band[0] && value <= band[1];

const gapMatches = (item: InterviewGapItem, e: GapExpectation): boolean =>
  item.weakness_type === e.weakness_type &&
  (e.skill_canonical === undefined || item.skill_canonical === (e.skill_canonical ?? null));

const gapKey = (e: GapExpectation): string =>
  `${e.weakness_type}|${e.skill_canonical === undefined ? '*' : (e.skill_canonical ?? '∅')}`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function scoreInterviewProductionCase(
  c: InterviewProductionCase,
): InterviewProductionResult {
  const mismatches: string[] = [];

  if (!VALID_LOCALES.has(c.locale)) {
    return {
      id: c.id,
      pass: false,
      overall: 0,
      mismatches: [`unsupported locale "${String(c.locale)}"`],
    };
  }

  const contexts: AnswerGapContext[] = [];
  const answers: AnswerScore[] = [];
  const notes: Array<{ turn: number; note: string }> = [];

  c.turns.forEach((t, index) => {
    const turnNo = index + 1;
    const signals = analyzeAnswerSignals({
      answer: t.answer,
      question: t.question,
      jd_terms: t.jd_terms ?? [],
      language: c.locale,
    });
    const insight: AnswerInsight = {
      ...groundAnswerInsight(t.model_output ?? null, signals),
      ...t.insight,
    };

    const decision = decideTurn({
      signal: t.depth_signal,
      drill_depth: t.drill_depth,
      drill_budget: t.drill_budget,
      turns_used: t.turns_used ?? index,
      turn_budget: c.turn_budget,
      evasive_streak: t.evasive_streak ?? 0,
      seniority_target: c.seniority,
    });
    const accepted = [t.expected_decision, ...(t.accept_decisions ?? [])];
    if (!accepted.includes(decision)) {
      mismatches.push(`turn ${turnNo} decision ${decision} != expected ${accepted.join('/')}`);
    }

    for (const flag of t.expected_flags ?? []) {
      if (!FLAG_CHECKS[flag](signals)) {
        mismatches.push(`turn ${turnNo} expected flag ${flag} did not fire`);
      }
    }
    for (const flag of t.forbidden_flags ?? []) {
      if (FLAG_CHECKS[flag](signals)) {
        mismatches.push(`turn ${turnNo} forbidden flag ${flag} fired`);
      }
    }

    if (t.expected_score_band && !inBand(t.score, t.expected_score_band)) {
      mismatches.push(
        `turn ${turnNo} score ${t.score} outside band [${t.expected_score_band.join(',')}]`,
      );
    }

    contexts.push({
      topic_phase: t.topic_phase,
      skill_canonical: t.skill_canonical ?? null,
      display_name: t.display_name,
      linked_question_id: `q${turnNo}`,
      answer_excerpt: t.answer,
      signals,
      insight,
    });
    answers.push({ topic_phase: t.topic_phase, score: t.score, depth_signal: t.depth_signal });
    if (insight.note) notes.push({ turn: turnNo, note: insight.note });
  });

  const gaps = deriveInterviewGaps(contexts);

  for (const expected of c.expected_final_gaps) {
    if (!gaps.some((g) => gapMatches(g, expected))) {
      mismatches.push(`missing required gap ${gapKey(expected)}`);
    }
  }
  for (const forbidden of c.forbidden_gaps ?? []) {
    if (gaps.some((g) => gapMatches(g, forbidden))) {
      mismatches.push(`forbidden gap emitted ${gapKey(forbidden)}`);
    }
  }

  // forbidden-claim scan over ENGINE narration only — never the candidate's own words.
  const claims = [...GLOBAL_FORBIDDEN_CLAIMS, ...(c.forbidden_claims ?? [])];
  const engineTexts: Array<{ where: string; text: string }> = [
    ...gaps.map((g) => ({
      where: `gap recommended_action (${g.weakness_type})`,
      text: g.recommended_action,
    })),
    ...notes.map((n) => ({ where: `insight note (turn ${n.turn})`, text: n.note })),
  ];
  for (const { where, text } of engineTexts) {
    const lower = text.toLowerCase();
    for (const claim of claims) {
      if (lower.includes(claim.toLowerCase())) {
        mismatches.push(`forbidden claim "${claim}" in ${where}`);
      }
    }
  }

  const aggregate = aggregateInterviewScore({
    answers,
    role: c.target_role,
    seniority: c.seniority,
  });
  if (c.expected_overall_band && !inBand(aggregate.overall, c.expected_overall_band)) {
    mismatches.push(
      `overall ${aggregate.overall} outside band [${c.expected_overall_band.join(',')}]`,
    );
  }

  return { id: c.id, pass: mismatches.length === 0, overall: aggregate.overall, mismatches };
}
