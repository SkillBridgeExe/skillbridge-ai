/**
 * Interview Gap Derive — PR3: `deriveInterviewGaps`.
 *
 * A PURE, deterministic deriver that turns per-answer Layer-1 signals (`AnswerSignals`) + Layer-2
 * insight (`AnswerInsight`) into the EXISTING `InterviewGapItem[]`, so the interview gap report is
 * GROUNDED in code-owned signals — not only LLM narration. No LLM, no IO, no NestJS DI.
 *
 * It COMPLEMENTS (does NOT replace) the LLM-narrated gap path. Both feed the same
 * `InterviewGapItem` shape and the same `groundInterviewGaps` chokepoint.
 *
 * Review-locked rules honoured here:
 *  - `behavioral_gap` is emitted ONLY when the topic phase is BEHAVIORAL or SCENARIO — NEVER for a
 *    short technical answer (SKILL_PROBE/JD_REQUIREMENT) that merely lacks a STAR structure.
 *  - `role_fit_risk` is NOT derived here. Role-fit is a holistic, cross-answer seniority judgment;
 *    it is left to the LLM-narrated path (and only that path emits `role_fit_risk`).
 *  - BOUNDED + DEDUPED: at most ONE gap per (skill∥topic, weakness_type), keeping MAX severity. A
 *    single skill-level `knowledge_gap` cites the missed JD terms — never one item per missed term.
 *  - `evidence_from_answer` is `maskPii`'d + truncated (EVIDENCE_MAX=280, mirroring interview-gap.ts).
 *  - Every emitted item sets `linked_question_id` + a non-empty evidence + (for skill/evidence) a
 *    `skill_canonical`, so the existing `groundInterviewGaps` keeps it.
 *
 * Source spec: docs/superpowers/plans/2026-06-21-interview-gap-derive-pr3.md.
 */

import { maskPii } from '../../common/services/pii-mask';
import { AnswerSignals } from './answer-analyzer';
import { AnswerInsight } from './answer-insight';
import { InterviewPhase } from './interview-agenda';
import { InterviewGapItem } from './interview-gap';

export interface AnswerGapContext {
  topic_phase: InterviewPhase;
  skill_canonical: string | null;
  /** skill/topic display name */
  display_name: string;
  linked_question_id: string;
  /** raw answer excerpt — masked + truncated into `evidence_from_answer` */
  answer_excerpt: string;
  signals: AnswerSignals;
  insight: AnswerInsight;
}

// ---------------------------------------------------------------------------
// Architect-tunable constants (never the LLM)
// ---------------------------------------------------------------------------

/** mirrors interview-gap.ts EVIDENCE_MAX — evidence is masked + truncated to this length. */
const EVIDENCE_MAX = 280;

/** phases where a technical/JD/scenario answer can carry a knowledge/evidence gap. */
const SKILL_TOPICS: ReadonlySet<InterviewPhase> = new Set<InterviewPhase>([
  'SKILL_PROBE',
  'JD_REQUIREMENT',
  'SCENARIO',
]);

/** phases where a missing STAR structure is a real behavioral weakness (review-locked). */
const BEHAVIORAL_PHASES: ReadonlySet<InterviewPhase> = new Set<InterviewPhase>([
  'BEHAVIORAL',
  'SCENARIO',
]);

/** filler-count threshold that, alone, contributes one fired communication signal. */
const FILLER_THRESHOLD = 4;

/** JD coverage below this (with missed terms) signals a knowledge gap. */
const COVERAGE_FLOOR = 0.5;

/** per-fired-signal severity weight for communication_gap. */
const COMMUNICATION_WEIGHT = 0.3;

/** evidence_gap severities. */
const OVERCLAIMED_SEVERITY = 0.8;
const THIN_EVIDENCE_SEVERITY = 0.5;

const STAR_PART_LABELS: Array<[keyof AnswerInsight['star_present'], string]> = [
  ['situation', 'situation'],
  ['task', 'task'],
  ['action', 'action'],
  ['result', 'result'],
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const maskTruncate = (value: string): string => {
  const masked = maskPii(value);
  return masked.length > EVIDENCE_MAX ? masked.slice(0, EVIDENCE_MAX) : masked;
};

/** join a list of human terms with commas, for templated recommended_action / evidence text. */
const joinTerms = (terms: string[]): string => terms.join(', ');

// ---------------------------------------------------------------------------
// per-context rules — each returns 0..1 gap items (pre-mask, pre-dedup)
// ---------------------------------------------------------------------------

function deriveKnowledgeGap(c: AnswerGapContext): InterviewGapItem | null {
  if (!SKILL_TOPICS.has(c.topic_phase)) return null;
  const { coverage, missed } = c.signals.jd_term_hits;
  if (coverage >= COVERAGE_FLOOR || missed.length === 0) return null;

  return {
    requirement_id: null,
    target_type: 'skill',
    skill_canonical: c.skill_canonical,
    display_name: c.display_name,
    weakness_type: 'knowledge_gap',
    severity: clamp01(1 - coverage),
    evidence_from_answer: c.answer_excerpt,
    recommended_action: `Strengthen ${c.display_name}: the answer missed ${joinTerms(missed)}.`,
    linked_question_id: c.linked_question_id,
  };
}

function deriveEvidenceGap(c: AnswerGapContext): InterviewGapItem | null {
  if (!SKILL_TOPICS.has(c.topic_phase)) return null;
  // evidence_quality is the authoritative signal: 'strong' = a specific example (L2 has_specific_example)
  // OR a quantified result (L1 is_quantified). Only thin/overclaimed answers carry an evidence gap — so a
  // qualitative specific example (strong, but no number) does NOT fire here (design Q2: flows from the
  // upgraded evidence_quality rather than the narrow L1 has_concrete_example).
  const quality = c.insight.evidence_quality;
  if (quality === 'strong') return null;

  const severity = quality === 'overclaimed' ? OVERCLAIMED_SEVERITY : THIN_EVIDENCE_SEVERITY;
  return {
    requirement_id: null,
    target_type: 'evidence',
    skill_canonical: c.skill_canonical,
    display_name: c.display_name,
    weakness_type: 'evidence_gap',
    severity,
    evidence_from_answer: c.answer_excerpt,
    recommended_action: `Add a concrete example/metric for ${c.display_name}.`,
    linked_question_id: c.linked_question_id,
  };
}

function deriveCommunicationGap(c: AnswerGapContext): InterviewGapItem | null {
  const fired = [
    c.insight.off_topic,
    c.insight.clarity === 'unclear',
    c.signals.flags.rambling_risk,
    c.signals.filler.count >= FILLER_THRESHOLD,
  ].filter(Boolean).length;
  if (fired < 1) return null;

  return {
    requirement_id: null,
    target_type: 'communication',
    skill_canonical: null,
    display_name: c.display_name,
    weakness_type: 'communication_gap',
    severity: clamp01(COMMUNICATION_WEIGHT * fired),
    evidence_from_answer: c.answer_excerpt,
    recommended_action:
      'Tighten the answer: stay on the question, cut filler, and lead with the point.',
    linked_question_id: c.linked_question_id,
  };
}

function deriveBehavioralGap(c: AnswerGapContext): InterviewGapItem | null {
  // Review-locked: ONLY behavioral/scenario phases — never a short technical answer.
  if (!BEHAVIORAL_PHASES.has(c.topic_phase)) return null;

  // L2 (model-judged) star_present is the source of truth. Missing entirely (defensive) or all four
  // present → complete → no gap. (After this guard, `missing` always has >= 1 entry.)
  const sp = c.insight.star_present;
  if (!sp || (sp.situation && sp.task && sp.action && sp.result)) return null;

  const missing = STAR_PART_LABELS.filter(([key]) => !sp[key]).map(([, label]) => label);

  return {
    requirement_id: null,
    target_type: 'behavioral',
    skill_canonical: null,
    display_name: c.display_name,
    weakness_type: 'behavioral_gap',
    severity: clamp01(missing.length / STAR_PART_LABELS.length),
    evidence_from_answer: `Answer is missing STAR parts: ${joinTerms(missing)}. — ${c.answer_excerpt}`,
    recommended_action: `Structure with STAR (missing: ${joinTerms(missing)}).`,
    linked_question_id: c.linked_question_id,
  };
}

// role_fit_risk is intentionally NOT derived here (holistic seniority judgment → LLM-narrated path).

const RULES: Array<(c: AnswerGapContext) => InterviewGapItem | null> = [
  deriveKnowledgeGap,
  deriveEvidenceGap,
  deriveCommunicationGap,
  deriveBehavioralGap,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive grounded `InterviewGapItem`s from per-answer signals + insight.
 * Pure + deterministic: same input → same output. The result is masked, deduped (one item per
 * (skill∥topic, weakness_type) keeping MAX severity), and sorted by severity descending.
 */
export function deriveInterviewGaps(contexts: AnswerGapContext[]): InterviewGapItem[] {
  const raw: InterviewGapItem[] = [];
  for (const c of contexts) {
    for (const rule of RULES) {
      const item = rule(c);
      if (item) raw.push(item);
    }
  }

  // mask + truncate evidence on every item.
  for (const item of raw) {
    item.evidence_from_answer = maskTruncate(item.evidence_from_answer);
  }

  // dedup by (skill_canonical ?? display_name) + '|' + weakness_type, keeping MAX severity.
  const byKey = new Map<string, InterviewGapItem>();
  for (const item of raw) {
    const key = `${item.skill_canonical ?? item.display_name}|${item.weakness_type}`;
    const existing = byKey.get(key);
    if (!existing || item.severity > existing.severity) byKey.set(key, item);
  }

  return [...byKey.values()].sort((a, b) => b.severity - a.severity);
}
