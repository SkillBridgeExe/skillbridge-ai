import { ValidationStatus } from '../roadmap/learning-resource';

/**
 * Deterministic core of the offline resource-curation AI (pure, no LLM/IO). The LLM only ASSESSES a
 * candidate resource on the CRAAP dimensions (Currency, Relevance, Authority, Accuracy, Purpose — the
 * standard rubric for evaluating online sources) and writes a clean description; THIS code owns the
 * reproducible quality_score, the verified/pending/flagged decision, and the anti-fabrication guard.
 *
 * Promotes a `pending` catalog resource → `verified` only when the deterministic rules pass — a bad/empty
 * model response can never auto-verify (it degrades to `pending` = human review). Weights + thresholds are
 * the AI-architect's tunable knobs.
 */

export interface CraapScores {
  relevance: number; // does it actually teach the claimed skills at a useful depth?
  authority: number; // provider/author credibility
  currency: number; // up-to-date for a fast-moving tech?
  accuracy: number; // correctness signals
  purpose: number; // educational vs promotional
}

export const CRAAP_WEIGHTS: CraapScores = {
  relevance: 0.3,
  authority: 0.2,
  currency: 0.2,
  accuracy: 0.15,
  purpose: 0.15,
};

/** quality_score (0-100) at/above which a skilled, unflagged resource is auto-verified. Architect-tunable. */
export const VERIFY_THRESHOLD = 60;

export const CURATION_FLAGS = [
  'promotional',
  'outdated',
  'paywalled',
  'no_skill_detected',
  'low_quality',
] as const;
export type CurationFlag = (typeof CURATION_FLAGS)[number];
/** Flags that disqualify a resource outright (→ flagged), independent of the numeric score. */
const HARD_FLAGS: ReadonlySet<CurationFlag> = new Set(['promotional', 'no_skill_detected']);

export interface CurationInput {
  title: string;
  provider: string;
  description?: string;
  skills: string[]; // declared canonical skills
  url?: string;
}

export interface CuratedResource {
  quality_score: number; // 0-100
  validation_status: ValidationStatus; // verified | pending | flagged
  description: string;
  flags: CurationFlag[];
  craap: CraapScores;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const MAX_DESC_LEN = 600;
/** Soft flags reduce trust but don't disqualify outright — they cap the result at pending (never verified). */
const SOFT_FLAGS: ReadonlySet<CurationFlag> = new Set(['outdated', 'paywalled', 'low_quality']);
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
/** Strips any link an LLM may copy from a marketing blurb into the curated description: any scheme://, www.,
 * a host.tld/PATH (catches scheme-less promo hosts like promo.example/buy, bit.ly/xyz, t.me/chan), or a
 * known bare shortener. Keeps the curated catalog description free of unvetted destinations. */
const URL_LIKE = new RegExp(
  [
    '\\b[a-z][a-z0-9+.\\-]*:\\/\\/\\S+',
    '\\bwww\\.\\S+',
    '\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}\\/\\S*',
    '\\b(?:bit\\.ly|t\\.me|youtu\\.be|t\\.co|goo\\.gl|tinyurl\\.com)\\S*',
  ].join('|'),
  'gi',
);

/** Weighted CRAAP aggregate → integer 0-100. Pure + clamped. */
export function aggregateQuality(craap: CraapScores): number {
  const w = CRAAP_WEIGHTS;
  const score =
    clamp01(craap.relevance) * w.relevance +
    clamp01(craap.authority) * w.authority +
    clamp01(craap.currency) * w.currency +
    clamp01(craap.accuracy) * w.accuracy +
    clamp01(craap.purpose) * w.purpose;
  return Math.round(score * 100);
}

/** verified (good + skilled + clean) · flagged (hard flag or no skills) · pending (below threshold → human review). */
export function decideValidation(
  quality: number,
  flags: CurationFlag[],
  hasSkills: boolean,
): ValidationStatus {
  if (!hasSkills) return 'flagged';
  if (flags.some((f) => HARD_FLAGS.has(f))) return 'flagged';
  if (quality >= VERIFY_THRESHOLD) return 'verified';
  return 'pending';
}

function normalizeCraap(v: unknown): CraapScores {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (x: unknown): number => clamp01(typeof x === 'number' ? x : 0);
  return {
    relevance: num(o.relevance),
    authority: num(o.authority),
    currency: num(o.currency),
    accuracy: num(o.accuracy),
    purpose: num(o.purpose),
  };
}

function cleanDescription(text: string): string {
  return text
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL_LIKE, '[link]')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_DESC_LEN);
}

/**
 * Ground the LLM's curation output against the input + the deterministic rules. Anti-fabrication:
 * strip raw URLs from the description, drop unknown flags, and on bad/empty model output fall back to
 * `pending` (human review) with a neutral title-based description — never an auto-verify on garbage.
 */
export function groundCuration(parsed: unknown, input: CurationInput): CuratedResource {
  const hasSkills = input.skills.length > 0;
  // Curation FAILED → neutral title-based description (don't propagate the un-vetted raw description as if curated).
  const fallback = (): CuratedResource => ({
    quality_score: 0,
    validation_status: hasSkills ? 'pending' : 'flagged',
    description: cleanDescription(input.title),
    flags: ['low_quality'],
    craap: { relevance: 0, authority: 0, currency: 0, accuracy: 0, purpose: 0 },
  });

  if (typeof parsed !== 'object' || parsed === null) return fallback();
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.craap !== 'object' || obj.craap === null) return fallback();

  const craap = normalizeCraap(obj.craap);
  const quality_score = aggregateQuality(craap);

  const rawFlags = Array.isArray(obj.flags) ? obj.flags : [];
  const flags = [...new Set(rawFlags)].filter((f): f is CurationFlag =>
    CURATION_FLAGS.includes(f as CurationFlag),
  );

  const description =
    typeof obj.description === 'string' && obj.description.trim() !== ''
      ? cleanDescription(obj.description)
      : cleanDescription(input.description?.trim() || input.title);

  // Content-safety downgrades on top of the core decision (can only LOWER, never raise): pure marketing
  // (purpose level 0) → flagged; half-promo (purpose level 1) or any soft flag → cap at pending. So an
  // engine-flagged-`outdated` or marketing-leaning resource can never auto-verify on a single missing hard flag.
  let validation_status = decideValidation(quality_score, flags, hasSkills);
  if (validation_status === 'verified') {
    if (craap.purpose < 0.2) validation_status = 'flagged';
    else if (craap.purpose < 0.5 || flags.some((f) => SOFT_FLAGS.has(f)))
      validation_status = 'pending';
  }

  return { quality_score, validation_status, description, flags, craap };
}
