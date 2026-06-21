/**
 * Answer Insight — Layer 2 (PR2): grounded LLM-judgment contract + `groundAnswerInsight`.
 *
 * Layer 1 (`answer-analyzer.ts`) owns every COUNTABLE signal. Layer 2 is a single, schema-enforced,
 * temp-0 LLM call (`AnswerInsightService`) that judges ONLY the nuanced layer — talking_point,
 * relevance, clarity, off_topic, confidence_tone, note. It NEVER recomputes a count.
 *
 * `groundAnswerInsight` is the anti-fabrication chokepoint: CODE validates/clamps/falls-back the
 * model output AND DERIVES `evidence_quality` from Layer 1 signals — the model never provides
 * evidence_quality (it is not even in the schema). Any LLM/parse failure → `groundAnswerInsight(null,
 * signals)`, a deterministic safe fallback. Mirrors `learning-chat/chat-grounding.ts` (grounding) +
 * `resource-curation/curation.service.ts` (degrade-never-throw).
 *
 * Source spec: docs/superpowers/specs/2026-06-21-interview-answer-analyzer-design.md (§4).
 */

import { AnswerSignals } from './answer-analyzer';

export type TalkingPoint = 'experience' | 'skill' | 'project' | 'goal' | 'impact';
export type Clarity = 'unclear' | 'adequate' | 'clear';
export type ConfidenceTone = 'under' | 'calibrated' | 'over';
/** DERIVED BY CODE from Layer 1 — never trusted from the model. */
export type EvidenceQuality = 'strong' | 'thin' | 'overclaimed';

export interface StarPresent {
  situation: boolean;
  task: boolean;
  action: boolean;
  result: boolean;
}

export interface AnswerInsight {
  talking_point: TalkingPoint;
  relevance: number; // 0..100
  clarity: Clarity;
  off_topic: boolean;
  confidence_tone: ConfidenceTone;
  evidence_quality: EvidenceQuality; // code-derived from L1 (NOT a model field)
  note: string;
  /** model-judged: did the candidate give a specific example (not just a claim)? */
  has_specific_example: boolean;
  /** model-judged: decomposed STAR presence — each component judged independently. */
  star_present: StarPresent;
}

// ---------------------------------------------------------------------------
// Defaults + valid enum sets (architect-tunable, never the LLM)
// ---------------------------------------------------------------------------

const TALKING_POINTS: ReadonlySet<TalkingPoint> = new Set([
  'experience',
  'skill',
  'project',
  'goal',
  'impact',
]);
const CLARITIES: ReadonlySet<Clarity> = new Set(['unclear', 'adequate', 'clear']);
const CONFIDENCE_TONES: ReadonlySet<ConfidenceTone> = new Set(['under', 'calibrated', 'over']);

const DEFAULT_TALKING_POINT: TalkingPoint = 'experience';
const DEFAULT_CLARITY: Clarity = 'adequate';
const DEFAULT_CONFIDENCE_TONE: ConfidenceTone = 'calibrated';
const DEFAULT_RELEVANCE = 50;

/** When L1 sees rambling AND the model's own relevance is below this, off_topic is forced true. */
const OFF_TOPIC_RELEVANCE_FLOOR = 40;
const NOTE_MAX_LEN = 200;

/**
 * The schema enforced ON THE MODEL — exactly the 8 nuance fields it is allowed to produce.
 * `evidence_quality` is DELIBERATELY ABSENT: code derives it from Layer 1; the model must not output
 * it. `additionalProperties:false` keeps the model from smuggling in countable metrics.
 */
export const ANSWER_INSIGHT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'talking_point',
    'relevance',
    'clarity',
    'off_topic',
    'confidence_tone',
    'note',
    'has_specific_example',
    'star_present',
  ],
  properties: {
    talking_point: { type: 'string', enum: [...TALKING_POINTS] },
    relevance: { type: 'number', minimum: 0, maximum: 100 },
    clarity: { type: 'string', enum: [...CLARITIES] },
    off_topic: { type: 'boolean' },
    confidence_tone: { type: 'string', enum: [...CONFIDENCE_TONES] },
    note: { type: 'string', maxLength: NOTE_MAX_LEN },
    has_specific_example: { type: 'boolean' },
    star_present: {
      type: 'object',
      additionalProperties: false,
      required: ['situation', 'task', 'action', 'result'],
      properties: {
        situation: { type: 'boolean' },
        task: { type: 'boolean' },
        action: { type: 'boolean' },
        result: { type: 'boolean' },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// note hardening (strip raw URLs — mirrors chat-grounding.stripRawUrls)
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

function sanitizeNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL_LIKE, '[link]')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, NOTE_MAX_LEN);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pickEnum<T extends string>(value: unknown, valid: ReadonlySet<T>, fallback: T): T {
  return typeof value === 'string' && valid.has(value as T) ? (value as T) : fallback;
}

function clampRelevance(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RELEVANCE;
  return Math.max(0, Math.min(100, value));
}

/**
 * evidence_quality is OWNED BY CODE, derived from L1 signals + L2 model judgment
 * (review-locked anti-fabrication rule):
 *   - has_specific_example (model-judged, L2) OR signals.is_quantified (L1) → `strong`
 *   - else an over-confident tone (assertive but no specific example) → `overclaimed`
 *   - else → `thin`
 * The model's evidence_quality (if any) is IGNORED.
 */
function deriveEvidenceQuality(
  signals: AnswerSignals,
  confidence_tone: ConfidenceTone,
  has_specific_example: boolean,
): EvidenceQuality {
  if (has_specific_example || signals.is_quantified) return 'strong';
  if (confidence_tone === 'over') return 'overclaimed';
  return 'thin';
}

// ---------------------------------------------------------------------------
// Public API — the anti-fabrication grounding chokepoint
// ---------------------------------------------------------------------------

/** Safe default star_present when on degrade path (object missing/null/non-object). */
const DEGRADE_STAR_PRESENT: StarPresent = {
  situation: true,
  task: true,
  action: true,
  result: true,
};

/**
 * Coerce a raw star_present value from the model into a validated StarPresent.
 * - If the raw value is missing / null / not-an-object → degrade: all four default to true
 *   (meaning "no missing STAR detectable" — prevents false-fire gap logic on degrade).
 * - If the raw value IS an object → each part coerces with `=== true`; missing/non-bool → false.
 */
function groundStarPresent(raw: unknown): StarPresent {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEGRADE_STAR_PRESENT };
  }
  const r = raw as Record<string, unknown>;
  return {
    situation: r.situation === true,
    task: r.task === true,
    action: r.action === true,
    result: r.result === true,
  };
}

/**
 * Ground a (possibly-bad / possibly-null) parsed LLM output into a safe `AnswerInsight`.
 * - validates enums → defaults on invalid/missing,
 * - clamps relevance 0..100 (non-number → 50),
 * - coerces off_topic; RAISES it to true when L1 rambling_risk AND relevance < 40 (safety net),
 * - coerces has_specific_example with `=== true` (default false when missing/null/non-bool),
 * - coerces star_present: degrade path (obj missing/null/non-obj) → all four true;
 *   object present → each part coerced with `=== true`, missing/non-bool → false,
 * - DERIVES evidence_quality from has_specific_example OR L1 is_quantified (never the model),
 * - hardens note (string, trimmed, URL-stripped, <=200 chars),
 * - `parsed === null` → full safe fallback (defaults + L1-derived evidence_quality + empty note).
 */
export function groundAnswerInsight(parsed: unknown, signals: AnswerSignals): AnswerInsight {
  const isObject = parsed !== null && typeof parsed === 'object';
  const obj: Record<string, unknown> = isObject ? (parsed as Record<string, unknown>) : {};

  const talking_point = pickEnum(obj.talking_point, TALKING_POINTS, DEFAULT_TALKING_POINT);
  const clarity = pickEnum(obj.clarity, CLARITIES, DEFAULT_CLARITY);
  const confidence_tone = pickEnum(obj.confidence_tone, CONFIDENCE_TONES, DEFAULT_CONFIDENCE_TONE);
  const relevance = clampRelevance(obj.relevance);

  let off_topic = obj.off_topic === true;
  // deterministic safety net: L1 says this is rambling AND the model's own relevance is low → off-topic.
  if (signals.flags.rambling_risk && relevance < OFF_TOPIC_RELEVANCE_FLOOR) off_topic = true;

  // has_specific_example: strict boolean coerce (model-judged); degrade → false.
  const has_specific_example = obj.has_specific_example === true;

  // star_present: degrade path when parsed is null/non-object → all true; else per-part coerce.
  const star_present = isObject ? groundStarPresent(obj.star_present) : { ...DEGRADE_STAR_PRESENT };

  const evidence_quality = deriveEvidenceQuality(signals, confidence_tone, has_specific_example);
  const note = sanitizeNote(obj.note);

  return {
    talking_point,
    relevance,
    clarity,
    off_topic,
    confidence_tone,
    evidence_quality,
    note,
    has_specific_example,
    star_present,
  };
}
