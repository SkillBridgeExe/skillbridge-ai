/**
 * CV-builder chat companion — the fabrication gate (PURE, no IO, no LLM). SAFETY-CRITICAL:
 * fabrication/embellishment held to 0 is a HARD invariant.
 *
 * Reuses the shipped rewrite anti-invention counter verbatim:
 *   - the PROSE gate ({@link firstUngroundedToken}) runs the number / tech / url / proper-noun /
 *     credential / temporal nets over the assistant's message; any token the user didn't license → refuse.
 *   - the PROPOSED-EDIT gate hands `after` straight to {@link groundCvRewrite} (the shipped verdict).
 *
 * Licensed sources = the user's OWN turns (`candidateSaid`) + the original focused text ONLY.
 * NEVER the assistant's prior turns — a number the model itself said last turn licenses nothing.
 */
import {
  groundCvRewrite,
  numberTokens,
  hasWord,
  urlTokens,
  properNounPhrases,
  temporalTokens,
  NAMED_TECH,
  CREDENTIAL_WORDS,
} from '../cv-assistant/cv-assistant-rewrite';
import type { CvBuilderChatFacts } from './cv-builder-chat.facts';
import type { CvBuilderChatModelOutput } from './cv-builder-chat.schema';

export type CvChatAnswerKind = 'grounded' | 'refusal' | 'canned';

export interface CvGroundedFact {
  kind: 'user_answer' | 'original_bullet' | 'detected_gap';
  text: string;
  field_path?: string;
}

export interface CvBuilderKnownState {
  target_role: string | null;
  active_field_path: string | null;
  answered_gaps: string[];
}

export interface CvBuilderChatResult {
  answer: string;
  answer_kind: CvChatAnswerKind;
  /** present ONLY when the edit is grounded; null on refusal/canned. */
  proposed_edit: { field_path: string; before: string; after: string } | null;
  grounded_facts: CvGroundedFact[];
  suggested_next_step: string | null;
  /** left undefined here — the service attaches it in a later task. */
  known_state?: CvBuilderKnownState;
  trace?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// localized copy — every line is DIGIT-FREE (a refusal must not itself leak a
// number the user never gave; the whole point of the gate).
// ---------------------------------------------------------------------------

type Lang = 'vi' | 'en';
const asLang = (language: string): Lang =>
  (language ?? '').toLowerCase().startsWith('vi') ? 'vi' : 'en';

const GAP_HINT: Record<Lang, Record<string, string>> = {
  vi: {
    result: 'kết quả bạn đạt được',
    tech: 'công nghệ bạn đã dùng',
    action: 'việc bạn đã làm',
    role: 'vai trò bạn đang nhắm tới',
    strength: 'thế mạnh của bạn',
    evidence: 'kinh nghiệm của bạn',
  },
  en: {
    result: 'the result you achieved',
    tech: 'the tech you used',
    action: 'what you did',
    role: 'the role you are aiming for',
    strength: 'your strengths',
    evidence: 'your experience',
  },
};
const gapHint = (l: Lang, gap: string): string =>
  GAP_HINT[l][gap] ?? (l === 'vi' ? 'phần này' : 'this part');

function warmFallback(l: Lang, gaps: string[]): string {
  const hint = gaps.length ? gapHint(l, gaps[0]) : l === 'vi' ? 'phần này' : 'this part';
  return l === 'vi'
    ? `Bạn kể mình nghe thêm một chút về ${hint} nhé.`
    : `Tell me a bit more about ${hint}.`;
}

function proseRefusal(l: Lang): string {
  return l === 'vi'
    ? 'Mình chưa có đủ thông tin thật để viết chỗ đó — bạn cho mình con số hoặc chi tiết cụ thể bạn đã làm nhé.'
    : "I don't have real detail to write that yet — tell me the exact number or specifics you actually did.";
}

// `groundCvChat` always calls `groundCvRewrite` with `needs_detail: []`, so its verdict can only fail
// as UNGROUNDED here — the NEEDS_DETAIL arm was unreachable and has been dropped.
function editRefusal(l: Lang): string {
  return l === 'vi'
    ? 'Mình chưa có con số hay chi tiết thật cho chỗ đó — bạn cho mình biết cụ thể bạn đã làm gì nhé.'
    : "I don't have the real number or detail for that yet — tell me specifically what you did.";
}

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

/** strip any raw URL from displayed prose (defense in depth — the prose gate already refuses a
 *  link the user never gave; this keeps even a licensed link out of the chat bubble). */
function stripRawUrls(text: string): string {
  return text
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** gate a `suggested_next_step` chip through the SAME prose net as the message. The chip is rendered
 *  clickable, persisted, and replayed into history — an ungrounded claim here is the identical
 *  fabrication the gate refuses one field to the left. Any ungrounded token → drop the chip (null is
 *  honest; the FE simply shows none — no invented "verified default"). `licensed` is NFKC-folded. */
function groundSuggestion(next: string | null | undefined, licensed: string): string | null {
  if (typeof next !== 'string' || !next.trim()) return null;
  if (firstUngroundedToken(next, licensed) !== null) return null;
  return stripRawUrls(next);
}

/** non-ASCII Unicode decimal digits (Arabic-Indic ٤, Devanagari ४ …) survive NFKC and can never be
 *  ASCII-grounded (licensed numbers are ASCII) → fail CLOSED on the glyph itself. Mirrors the final arm
 *  of diagnosis-grounding's `ungroundedNumbers`. `nfkcText` must already be NFKC-folded. */
function firstNonAsciiDigitRun(nfkcText: string): string | null {
  for (const m of nfkcText.matchAll(/\p{Nd}+/gu)) if (/[^0-9]/.test(m[0])) return m[0];
  return null;
}

/**
 * The first token in `text` that asserts a fact the user never licensed, or null. `licensed` is the
 * user's own words + the original focused text, ALREADY NFKC-folded. START STRICT: any ungrounded
 * number / tech / url / entity / credential / temporal token → this fires (benign-advice allowance is
 * deferred to Slice 4 against the harness). Reuses the shipped rewrite nets verbatim.
 */
export function firstUngroundedToken(text: string, licensed: string): string | null {
  const t = text.normalize('NFKC');
  const src = licensed; // already NFKC-folded by the caller
  const srcLower = src.toLowerCase();

  // (b) numbers — unit-aware, exact token ("40%" ≠ "40ms", "3-5 years" ≠ "5 years").
  const allowedNumbers = new Set(numberTokens(src));
  for (const num of numberTokens(t)) if (!allowedNumbers.has(num)) return num;
  // fail CLOSED on non-ASCII Nd glyphs the ASCII scan above can't read.
  const nonAscii = firstNonAsciiDigitRun(t);
  if (nonAscii !== null) return nonAscii;

  // (c) fabricated SPECIFIC tech.
  for (const tech of NAMED_TECH) if (hasWord(t, tech) && !hasWord(src, tech)) return tech;
  // (d) fabricated URL / domain.
  for (const url of urlTokens(t)) if (!srcLower.includes(url)) return url;
  // (f) fabricated multi-word proper-noun (employer / org / product).
  for (const phrase of properNounPhrases(t))
    if (!srcLower.includes(phrase.toLowerCase())) return phrase;
  // (e) fabricated credential.
  for (const w of CREDENTIAL_WORDS) if (hasWord(t, w) && !hasWord(src, w)) return w;
  // (g) fabricated worded date/period.
  for (const tk of temporalTokens(t)) {
    const present = tk.includes(' ') ? srcLower.includes(tk) : hasWord(src, tk);
    if (!present) return tk;
  }
  return null;
}

/** honest provenance — advertise ONLY what is actually licensed. Never called on a refusal/canned path. */
function honestFacts(facts: CvBuilderChatFacts): CvGroundedFact[] {
  const out: CvGroundedFact[] = [];
  const f = facts.focus;
  if (f && f.current_text.trim())
    out.push({ kind: 'original_bullet', text: f.current_text, field_path: f.field_path });
  for (const gap of f?.gaps ?? []) out.push({ kind: 'detected_gap', text: gap });
  return out;
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

export function groundCvChat(
  parsed: unknown,
  facts: CvBuilderChatFacts,
  language: string,
  candidateSaid: string,
): CvBuilderChatResult {
  const l = asLang(language);
  const gaps = facts.focus?.gaps ?? [];

  // 1) transport / parse failure → deterministic honest fallback (never throw).
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { message?: unknown }).message !== 'string'
  ) {
    return {
      answer: warmFallback(l, gaps),
      answer_kind: 'canned',
      proposed_edit: null,
      grounded_facts: [],
      suggested_next_step: null,
    };
  }
  const p = parsed as CvBuilderChatModelOutput;

  // licensed corpus = the user's OWN turns + the original focused text ONLY (never the assistant's).
  const licensed = (candidateSaid + ' ' + (facts.focus?.current_text ?? '')).normalize('NFKC');

  // 2) prose gate — any ungrounded fact token → refuse, and NEVER echo the fabricating message.
  if (firstUngroundedToken(p.message, licensed) !== null) {
    return {
      answer: proseRefusal(l),
      answer_kind: 'refusal',
      proposed_edit: null,
      grounded_facts: [],
      suggested_next_step: null,
    };
  }

  // 3) proposed-edit gate — reuse the shipped rewrite anti-invention counter on `after`.
  const pe = p.proposed_edit;
  if (pe && typeof pe.after === 'string' && typeof pe.field_path === 'string') {
    const before = facts.focus?.current_text ?? '';
    const afterNfkc = pe.after.normalize('NFKC');
    // fail CLOSED on non-ASCII Nd digits groundCvRewrite's ASCII number scan can't read.
    if (firstNonAsciiDigitRun(afterNfkc) !== null) {
      return {
        answer: editRefusal(l),
        answer_kind: 'refusal',
        proposed_edit: null,
        grounded_facts: [],
        suggested_next_step: null,
      };
    }
    // used_facts:[] intentionally drops the redundant subset arm; token arms (b–g) still fully protect
    // `after`. facts:[licensed] makes groundCvRewrite's internal `source` the licensed corpus.
    const verdict = groundCvRewrite(
      before,
      { after: afterNfkc, used_facts: [] },
      { facts: [licensed], needs_detail: [] },
      { target: pe.field_path, why: '' },
    );
    if (verdict.ok) {
      return {
        answer: stripRawUrls(p.message),
        answer_kind: 'grounded',
        proposed_edit: {
          field_path: pe.field_path,
          before: verdict.field_patch.before,
          after: verdict.field_patch.after,
        },
        grounded_facts: honestFacts(facts),
        suggested_next_step: groundSuggestion(p.suggested_next_step, licensed),
      };
    }
    return {
      answer: editRefusal(l),
      answer_kind: 'refusal',
      proposed_edit: null,
      grounded_facts: [],
      suggested_next_step: null,
    };
  }

  // 4) prose-only, clean → grounded.
  return {
    answer: stripRawUrls(p.message),
    answer_kind: 'grounded',
    proposed_edit: null,
    grounded_facts: honestFacts(facts),
    suggested_next_step: groundSuggestion(p.suggested_next_step, licensed),
  };
}
