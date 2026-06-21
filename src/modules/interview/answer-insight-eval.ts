import { analyzeAnswerSignals, AnswerSignalInput } from './answer-analyzer';
import { AnswerInsight, groundAnswerInsight } from './answer-insight';

/**
 * Deterministic eval for the Answer Insight GROUNDING (Layer 2, PR2). It exercises
 * `groundAnswerInsight` — the anti-fabrication chokepoint — NOT a live LLM, so it runs with no API
 * key and no network. Each case provides:
 *   - `signal_input`: a Layer-1 input → signals are derived deterministically (kept self-consistent),
 *   - `model_output`: the raw (possibly-bad / possibly-null) parsed LLM output,
 *   - `expect`: the subset of the grounded `AnswerInsight` to assert (enums valid, relevance clamped,
 *     evidence_quality CODE-DERIVED, off_topic safety net).
 * This gates the grounding logic; the live LLM-judgment quality is a separate `--live` directional
 * pass later. Mirrors `answer-signals-eval.ts`.
 */

export interface AnswerInsightCase {
  id: string;
  /** Layer-1 input — signals are computed from this so the case stays self-consistent. */
  signal_input: AnswerSignalInput;
  /** raw parsed LLM output to ground; `null` simulates an LLM/parse failure. */
  model_output: unknown;
  /** the subset of the grounded AnswerInsight to check; deep-compared. */
  expect: Partial<AnswerInsight>;
}

export interface AnswerInsightEvalResult {
  id: string;
  pass: boolean;
  /** top-level keys of `expect` that did not deep-match the grounded output */
  mismatches: string[];
}

/** structural deep-equality for plain JSON values (objects/arrays/primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

export function scoreAnswerInsightCase(c: AnswerInsightCase): AnswerInsightEvalResult {
  const signals = analyzeAnswerSignals(c.signal_input);
  const grounded = groundAnswerInsight(c.model_output, signals) as unknown as Record<
    string,
    unknown
  >;
  const expected = c.expect as unknown as Record<string, unknown>;
  const mismatches = Object.keys(expected).filter((k) => !deepEqual(expected[k], grounded[k]));
  return { id: c.id, pass: mismatches.length === 0, mismatches };
}
