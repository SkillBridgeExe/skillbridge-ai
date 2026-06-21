import { analyzeAnswerSignals, Language } from './answer-analyzer';
import { AnswerInsight, groundAnswerInsight } from './answer-insight';
import { InterviewPhase } from './interview-agenda';
import { InterviewGapWeaknessType } from './interview-gap';
import { deriveInterviewGaps, AnswerGapContext } from './interview-gap-derive';

/**
 * Deterministic eval for the interview gap DERIVER (PR3). It exercises `deriveInterviewGaps` — a
 * pure signal+insight→gap mapping — with NO live LLM, NO network, NO API key. Each context is kept
 * self-consistent: Layer-1 `signals` are computed from the case `answer`/`jd_terms`/`language`, and
 * the Layer-2 `insight` is grounded from `model_output` (`null` = LLM/parse failure → safe
 * fallback). An optional `insight` override pins a nuance field (e.g. `evidence_quality`,
 * `off_topic`) without fighting the heuristics — mirroring the unit-test helper.
 *
 * A case asserts the EMITTED gaps' `(weakness_type, skill_canonical)` SET plus per-expectation
 * severity BANDS (`severity_min`/`severity_max`, inclusive). Both "the expected gaps are present"
 * and "no extra gaps are emitted" are checked, so a case can pin "clean answer → NO gaps". Mirrors
 * `answer-signals-eval.ts` / `answer-insight-eval.ts`.
 */

export interface GapDeriveContextCase {
  topic_phase: InterviewPhase;
  skill_canonical: string | null;
  display_name: string;
  linked_question_id: string;
  /** raw answer — masked+truncated into evidence AND analyzed for Layer-1 signals. */
  answer: string;
  jd_terms?: string[];
  language: Language;
  /** raw parsed LLM output to ground into the insight; `null`/absent → safe fallback. */
  model_output?: unknown;
  /** optional override of grounded insight fields (e.g. force off_topic / evidence_quality). */
  insight?: Partial<AnswerInsight>;
}

export interface GapDeriveExpect {
  weakness_type: InterviewGapWeaknessType;
  /** expected skill on the emitted item (null for communication/behavioral). */
  skill_canonical?: string | null;
  /** inclusive severity band; omit a bound to leave it open. */
  severity_min?: number;
  severity_max?: number;
}

export interface GapDeriveCase {
  id: string;
  contexts: GapDeriveContextCase[];
  /** the full set of gaps expected (no more, no fewer). Empty = NO gaps. */
  expect: GapDeriveExpect[];
}

export interface GapDeriveEvalResult {
  id: string;
  pass: boolean;
  /** human-readable reasons the case did not match. */
  mismatches: string[];
}

/** build a self-consistent AnswerGapContext from a case context (signals + grounded insight). */
function toContext(cc: GapDeriveContextCase): AnswerGapContext {
  const signals = analyzeAnswerSignals({
    answer: cc.answer,
    jd_terms: cc.jd_terms ?? [],
    language: cc.language,
  });
  const insight: AnswerInsight = {
    ...groundAnswerInsight(cc.model_output ?? null, signals),
    ...cc.insight,
  };
  return {
    topic_phase: cc.topic_phase,
    skill_canonical: cc.skill_canonical,
    display_name: cc.display_name,
    linked_question_id: cc.linked_question_id,
    answer_excerpt: cc.answer,
    signals,
    insight,
  };
}

const keyOf = (weakness: InterviewGapWeaknessType, skill: string | null): string =>
  `${weakness}|${skill ?? '∅'}`;

export function scoreGapDeriveCase(c: GapDeriveCase): GapDeriveEvalResult {
  const items = deriveInterviewGaps(c.contexts.map(toContext));
  const mismatches: string[] = [];

  // index emitted items by (weakness_type, skill_canonical).
  const emitted = new Map<string, { severity: number }>();
  for (const item of items) {
    emitted.set(keyOf(item.weakness_type, item.skill_canonical), { severity: item.severity });
  }

  const expectedKeys = new Set<string>();
  for (const e of c.expect) {
    const key = keyOf(e.weakness_type, e.skill_canonical ?? null);
    expectedKeys.add(key);
    const hit = emitted.get(key);
    if (!hit) {
      mismatches.push(`missing ${key}`);
      continue;
    }
    if (e.severity_min !== undefined && hit.severity < e.severity_min) {
      mismatches.push(`${key} severity ${hit.severity} < min ${e.severity_min}`);
    }
    if (e.severity_max !== undefined && hit.severity > e.severity_max) {
      mismatches.push(`${key} severity ${hit.severity} > max ${e.severity_max}`);
    }
  }

  // any emitted gap not in the expected set is an unexpected extra.
  for (const key of emitted.keys()) {
    if (!expectedKeys.has(key)) mismatches.push(`unexpected ${key}`);
  }

  return { id: c.id, pass: mismatches.length === 0, mismatches };
}
