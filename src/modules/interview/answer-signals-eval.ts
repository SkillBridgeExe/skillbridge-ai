import { analyzeAnswerSignals, AnswerSignalInput, AnswerSignals } from './answer-analyzer';

/**
 * Deterministic eval for the Answer Analyzer Layer 1 (PR1). Each golden case asserts an EXPECTED
 * SUBSET of the analyzer output (only the keys it cares about) — because Layer 1 is exact, cases can
 * pin precise values (filler.count, star.*, jd_term_hits.hit/missed, conciseness, has_concrete_example,
 * flags). Self-consistent gate today; tune the heuristics against this golden to stay regression-safe.
 * No LLM, no network — mirrors the interview/learning evals.
 */

export interface AnswerSignalCase {
  id: string;
  input: AnswerSignalInput;
  /** the subset of signals to check; deep-compared against analyzeAnswerSignals(input) */
  expect: Partial<AnswerSignals>;
}

export interface AnswerSignalEvalResult {
  id: string;
  pass: boolean;
  /** top-level keys of `expect` that did not deep-match the analyzer output */
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

export function scoreAnswerSignalCase(c: AnswerSignalCase): AnswerSignalEvalResult {
  const actual = analyzeAnswerSignals(c.input) as unknown as Record<string, unknown>;
  const expected = c.expect as unknown as Record<string, unknown>;
  const mismatches = Object.keys(expected).filter((k) => !deepEqual(expected[k], actual[k]));
  return { id: c.id, pass: mismatches.length === 0, mismatches };
}
