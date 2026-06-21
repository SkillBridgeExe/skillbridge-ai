/**
 * Interview Coaching — PR4: `buildCoachingFacts` + `groundCoaching`.
 *
 * Closes the interview chain. Turns the DETERMINISTIC interview outputs (score + interview gaps +
 * unified development plan) into a human-facing coaching summary. Deterministic-first +
 * anti-fabrication:
 *
 *   - `buildCoachingFacts` (PURE): assembles CODE-OWNED facts — strengths from `InterviewScore`
 *     dimensions, priorities from the EXISTING `buildUnifiedPlan` buckets, top gaps from the
 *     EXISTING `InterviewGapItem`s. It NEVER calls an LLM and REUSES the existing engines (no new
 *     scorer / composer).
 *   - `groundCoaching` (PURE, anti-fabrication chokepoint): the LLM emits ONLY a narrative
 *     `summary` (+ per-priority `priority_notes`). `strengths` and `priorities` in the final
 *     `InterviewCoaching` are DERIVED FROM CODE FACTS — the model can NEVER add/remove/alter a
 *     priority or strength, nor invent a skill/resource/drill/CV-bullet/URL/number. The summary is
 *     URL-stripped + length-capped, and falls back to a TEMPLATED summary (built from facts) when
 *     the LLM output is missing/invalid. `parsed === null` → full templated fallback.
 *
 * Mirrors `answer-insight.ts` (grounding) + `chat-grounding.ts` (URL stripping).
 *
 * Source spec: docs/superpowers/plans/2026-06-21-interview-coaching-pr4.md.
 */

import { InterviewScore, ScoreBand } from './interview-scoring';
import { InterviewGapItem } from './interview-gap';
import {
  UnifiedDevelopmentPlan,
  UnifiedDevelopmentPlanItem,
  UnifiedTrack,
} from '../gap-report/unified-plan';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface CoachingFacts {
  overall: number;
  overall_band: ScoreBand;
  /** CODE: score dims banded solid/outstanding, top 3 by score. */
  strengths: Array<{ name: string; band: ScoreBand }>;
  /** CODE: top plan items across the 3 unified-plan buckets, by priority desc. */
  priorities: Array<{ track: UnifiedTrack; title: string; severity: number }>;
  /** CODE: top interview gaps by severity. */
  top_gaps: Array<{ display_name: string; weakness_type: InterviewGapItem['weakness_type'] }>;
}

export interface InterviewCoaching {
  /** LLM narrative — grounded, URL-stripped, length-capped, templated fallback. */
  summary: string;
  /** CODE-derived from facts.strengths ("<name>: <band>"). Model strengths are IGNORED. */
  strengths: string[];
  /** CODE title/track from facts.priorities; `why` from the matching LLM note or a templated fallback. */
  priorities: Array<{ track: UnifiedTrack; title: string; why: string }>;
}

// ---------------------------------------------------------------------------
// Architect-tunable constants (never the LLM)
// ---------------------------------------------------------------------------

/** how many banded-solid+ dimensions surface as strengths. */
const MAX_STRENGTHS = 3;
/** how many plan items surface as priorities (across all 3 buckets). */
const MAX_PRIORITIES = 4;
/** how many interview gaps surface as top_gaps. */
const MAX_TOP_GAPS = 4;
/** summary length cap. */
const SUMMARY_MAX = 600;
/** per-priority `why` length cap. */
const WHY_MAX = 300;

const SOLID_BANDS: ReadonlySet<ScoreBand> = new Set<ScoreBand>(['solid', 'outstanding']);

/**
 * The schema enforced ON THE MODEL — exactly the 2 narrative fields it is allowed to produce.
 * `strengths` and `priorities` are DELIBERATELY ABSENT: code owns them from the facts; the model
 * must not output them. `additionalProperties:false` keeps the model from smuggling in a fabricated
 * priority/strength/skill.
 */
export const COACHING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'priority_notes'],
  properties: {
    summary: { type: 'string', maxLength: SUMMARY_MAX },
    priority_notes: {
      type: 'array',
      items: { type: 'string', maxLength: WHY_MAX },
    },
  },
};

// ---------------------------------------------------------------------------
// Task 1 — buildCoachingFacts (PURE)
// ---------------------------------------------------------------------------

/**
 * Assemble the CODE-OWNED facts for coaching. PURE + deterministic — same input → same output.
 * REUSES the existing engines: `InterviewScore` dimensions for strengths, `buildUnifiedPlan`
 * buckets for priorities, `InterviewGapItem`s for top gaps. NO LLM, NO new scorer/composer.
 */
export function buildCoachingFacts(input: {
  score: InterviewScore;
  gaps: InterviewGapItem[];
  plan: UnifiedDevelopmentPlan;
}): CoachingFacts {
  const { score, gaps, plan } = input;

  const strengths = [...score.dimensions]
    .filter((d) => SOLID_BANDS.has(d.band))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_STRENGTHS)
    .map((d) => ({ name: d.dimension, band: d.band }));

  const allPlanItems: UnifiedDevelopmentPlanItem[] = [
    ...plan.learn_items,
    ...plan.cv_fix_items,
    ...plan.interview_practice_items,
  ];
  const priorities = [...allPlanItems]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_PRIORITIES)
    .map((p) => ({ track: p.track, title: p.display_name, severity: p.severity }));

  const top_gaps = [...gaps]
    .sort((a, b) => b.severity - a.severity)
    .slice(0, MAX_TOP_GAPS)
    .map((g) => ({ display_name: g.display_name, weakness_type: g.weakness_type }));

  return {
    overall: score.overall,
    overall_band: score.overall_band,
    strengths,
    priorities,
    top_gaps,
  };
}

// ---------------------------------------------------------------------------
// summary / why hardening (strip raw URLs — mirrors answer-insight.sanitizeNote)
// ---------------------------------------------------------------------------

const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const URL_LIKE = new RegExp(
  [
    '\\b[a-z][a-z0-9+.\\-]*:\\/\\/\\S+',
    '\\bwww\\.\\S+',
    '\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}\\/\\S*',
  ].join('|'),
  'gi',
);

function sanitizeText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL_LIKE, '[link]')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// templated fallbacks (built from CODE facts — never the LLM)
// ---------------------------------------------------------------------------

const TRACK_LABEL: Record<UnifiedTrack, string> = {
  learn: 'Learn',
  cv_fix: 'Strengthen CV evidence for',
  interview_practice: 'Practice',
};

/** Deterministic, fact-derived summary used when the LLM output is missing/invalid. */
function templatedSummary(facts: CoachingFacts): string {
  const head = `Overall ${facts.overall_band} (${facts.overall}).`;
  const strengthsPart =
    facts.strengths.length > 0
      ? ` Strengths: ${facts.strengths.map((s) => s.name).join(', ')}.`
      : '';
  const focusPart =
    facts.priorities.length > 0
      ? ` Focus next on: ${facts.priorities.map((p) => p.title).join(', ')}.`
      : '';
  return sanitizeText(`${head}${strengthsPart}${focusPart}`, SUMMARY_MAX);
}

/** Deterministic, fact-derived `why` used when the LLM omits/blanks a priority note. */
function templatedWhy(p: CoachingFacts['priorities'][number]): string {
  return `${TRACK_LABEL[p.track]} ${p.title} — this is a high-priority gap to close.`;
}

// ---------------------------------------------------------------------------
// Task 2 — groundCoaching (PURE, anti-fabrication chokepoint)
// ---------------------------------------------------------------------------

/**
 * Ground a (possibly-bad / possibly-null) parsed LLM output into a safe `InterviewCoaching`.
 *
 * Anti-fabrication rules (the WHOLE point):
 *   - `summary`: parsed.summary if a non-empty string → trimmed, URL-stripped, capped; else a
 *     TEMPLATED summary derived from facts.
 *   - `strengths`: ALWAYS code-derived from `facts.strengths` ("<name>: <band>"). Any model
 *     strengths are IGNORED — the model can never add/remove a strength.
 *   - `priorities`: ALWAYS code-owned (track + title from `facts.priorities`). The model can never
 *     add/remove/reorder a priority. Each `why` = the matching `parsed.priority_notes[i]` (trimmed,
 *     URL-stripped, capped) when present+valid, else a TEMPLATED why from track + title.
 *   - `parsed === null` → full templated fallback (summary + code strengths/priorities +
 *     templated whys).
 */
export function groundCoaching(parsed: unknown, facts: CoachingFacts): InterviewCoaching {
  const obj: Record<string, unknown> =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};

  // summary — model narrative if valid, else templated from facts.
  const rawSummary = sanitizeText(obj.summary, SUMMARY_MAX);
  const summary = rawSummary.length > 0 ? rawSummary : templatedSummary(facts);

  // strengths — ALWAYS code-derived from facts (model strengths IGNORED).
  const strengths = facts.strengths.map((s) => `${s.name}: ${s.band}`);

  // priorities — ALWAYS code-owned (track + title from facts); only `why` may come from the model.
  const notes = Array.isArray(obj.priority_notes) ? obj.priority_notes : [];
  const priorities = facts.priorities.map((p, i) => {
    const note = sanitizeText(notes[i], WHY_MAX);
    return { track: p.track, title: p.title, why: note.length > 0 ? note : templatedWhy(p) };
  });

  return { summary, strengths, priorities };
}
