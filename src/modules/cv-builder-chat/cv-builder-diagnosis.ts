/**
 * Diagnosis → CV-builder chat bridge (PURE, no IO, no LLM). Turns the latest CV-scan review into a
 * COMPACT, DIGIT-FREE block the builder companion can discuss in WORDS. SAFETY-CRITICAL: the
 * number-wall is the whole point — every string here is stripped of digit runs (ASCII AND non-ASCII
 * `\p{Nd}`) BEFORE it can enter the prompt or the grounding prose-license, so the mascot can never
 * repeat a score / percentage / count the scan produced. It licenses PROSE only: the two-corpus gate
 * (cv-chat-grounding.ts) keeps this text out of the edit corpus, so a tool the scan says the user is
 * MISSING never becomes something the model can insert into the CV.
 */
import type { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';

export interface CvBuilderDiagnosisBlock {
  /** Top prioritized fixes the scan surfaced — max 3, digit-stripped. */
  prioritized_actions: string[];
  /** Per-dimension rationale verbatim (digit-stripped), empty strings dropped. */
  dimension_notes: Array<{ dimension: string; note: string }>;
  /** Per-bullet line feedback — max 5 bullets that carry tips, excerpt cut to 120, all digit-stripped. */
  bullet_notes: Array<{ excerpt: string; tips: string[] }>;
}

const RATIONALE_DIMENSIONS = [
  'action_verbs',
  'skills_relevance',
  'experience',
  'education',
] as const;
const MAX_ACTIONS = 3;
const MAX_BULLETS = 5;
const EXCERPT_MAX = 120;

/**
 * Remove every digit run so no scan number survives into the prompt / prose-license:
 *   - ASCII digit runs incl. their decimal/percent/scale tail (`40%`, `3.5/5`, `100`) → removed.
 *   - any remaining Unicode decimal digit (Arabic-Indic ٤, Devanagari ४ …) → removed (fail-closed).
 * Then collapse the whitespace the removals leave behind.
 */
export function stripDigitRuns(s: string): string {
  return s
    .replace(/[0-9][0-9.,/%]*/g, '')
    .replace(/\p{Nd}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the digit-free diagnosis block from the latest review, or null when there is no review.
 * Everything is BE-authored text echoed VERBATIM minus digits — no paraphrase, no new claim minted here.
 */
export function buildDiagnosisChatBlock(
  review: CvReviewParsedResponse | null,
): CvBuilderDiagnosisBlock | null {
  if (!review) return null;

  const prioritized_actions = (review.top_summary?.prioritized_actions ?? [])
    .map(stripDigitRuns)
    .filter((a) => a.length > 0)
    .slice(0, MAX_ACTIONS);

  const rationale = review.rationale ?? ({} as CvReviewParsedResponse['rationale']);
  const dimension_notes = RATIONALE_DIMENSIONS.map((dimension) => ({
    dimension,
    note: stripDigitRuns(rationale[dimension] ?? ''),
  })).filter((d) => d.note.length > 0);

  const bullet_notes = (review.bullet_feedback ?? [])
    .filter((b) => Array.isArray(b.tips) && b.tips.length > 0)
    .slice(0, MAX_BULLETS)
    .map((b) => ({
      excerpt: stripDigitRuns(b.text).slice(0, EXCERPT_MAX),
      tips: b.tips.map(stripDigitRuns).filter((t) => t.length > 0),
    }))
    .filter((b) => b.tips.length > 0);

  return { prioritized_actions, dimension_notes, bullet_notes };
}

/**
 * Every string in the block joined with spaces — the PROSE license corpus (message gate only). Digit-
 * free by construction, so it can never widen the number-wall; two-corpus keeps it out of edits.
 */
export function diagnosisProseLicense(block: CvBuilderDiagnosisBlock | null): string {
  if (!block) return '';
  return [
    ...block.prioritized_actions,
    ...block.dimension_notes.map((d) => d.note),
    ...block.bullet_notes.flatMap((b) => [b.excerpt, ...b.tips]),
  ].join(' ');
}
