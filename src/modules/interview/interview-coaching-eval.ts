import { CoachingFacts, InterviewCoaching, groundCoaching } from './interview-coaching';

/**
 * Deterministic eval for the Interview Coaching GROUNDING (Layer 3, PR4). It exercises
 * `groundCoaching` — the anti-fabrication chokepoint — NOT a live LLM, so it runs with no API key
 * and no network. Each case provides:
 *   - `facts`: the CODE-OWNED CoachingFacts (the deterministic facts the LLM may only narrate),
 *   - `model_output`: the raw (possibly-bad / possibly-null) parsed LLM output to ground,
 *   - `expect`: assertions on the grounded `InterviewCoaching` — code-owned strengths/priorities,
 *     summary fallback/strip/cap, model-fabricated priority/strength ignored.
 * This gates the grounding logic; the live LLM narrative quality is a separate `--live` pass later.
 * Mirrors `answer-insight-eval.ts`.
 */

export interface InterviewCoachingCase {
  id: string;
  /** the CODE facts the LLM may only narrate. */
  facts: CoachingFacts;
  /** raw parsed LLM output to ground; `null` simulates an LLM/parse failure. */
  model_output: unknown;
  /** assertions on the grounded coaching. All listed checks must hold. */
  expect: {
    /** exact code-owned strengths array ("<name>: <band>"). */
    strengths?: string[];
    /** exact code-owned priority titles, in order. */
    priority_titles?: string[];
    /** the grounded summary must equal this string exactly. */
    summary_equals?: string;
    /** the grounded summary must contain each of these substrings. */
    summary_contains?: string[];
    /** the grounded summary must NOT contain any of these substrings (e.g. a leaked URL). */
    summary_excludes?: string[];
    /** the summary must be non-empty (fallback path). */
    summary_nonempty?: boolean;
    /** every priority `why` must be non-empty. */
    every_why_nonempty?: boolean;
    /** the grounded summary length must be <= this. */
    summary_max_len?: number;
  };
}

export interface InterviewCoachingEvalResult {
  id: string;
  pass: boolean;
  /** human-readable reasons the case failed (empty when pass). */
  mismatches: string[];
}

function arrEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function scoreInterviewCoachingCase(c: InterviewCoachingCase): InterviewCoachingEvalResult {
  const grounded: InterviewCoaching = groundCoaching(c.model_output, c.facts);
  const mismatches: string[] = [];
  const e = c.expect;

  if (e.strengths && !arrEq(grounded.strengths, e.strengths)) {
    mismatches.push(
      `strengths ${JSON.stringify(grounded.strengths)} != ${JSON.stringify(e.strengths)}`,
    );
  }
  if (e.priority_titles) {
    const titles = grounded.priorities.map((p) => p.title);
    if (!arrEq(titles, e.priority_titles)) {
      mismatches.push(
        `priority_titles ${JSON.stringify(titles)} != ${JSON.stringify(e.priority_titles)}`,
      );
    }
  }
  if (e.summary_equals !== undefined && grounded.summary !== e.summary_equals) {
    mismatches.push(`summary "${grounded.summary}" != "${e.summary_equals}"`);
  }
  for (const sub of e.summary_contains ?? []) {
    if (!grounded.summary.includes(sub)) mismatches.push(`summary missing "${sub}"`);
  }
  for (const sub of e.summary_excludes ?? []) {
    if (grounded.summary.includes(sub)) mismatches.push(`summary leaked "${sub}"`);
  }
  if (e.summary_nonempty && grounded.summary.trim().length === 0) {
    mismatches.push('summary is empty');
  }
  if (e.every_why_nonempty && !grounded.priorities.every((p) => p.why.trim().length > 0)) {
    mismatches.push('a priority why is empty');
  }
  if (e.summary_max_len !== undefined && grounded.summary.length > e.summary_max_len) {
    mismatches.push(`summary length ${grounded.summary.length} > ${e.summary_max_len}`);
  }

  return { id: c.id, pass: mismatches.length === 0, mismatches };
}
