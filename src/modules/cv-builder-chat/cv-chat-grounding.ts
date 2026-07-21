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
  normalizeNumberToken,
  NUMBER_TOKEN_RE,
  hasWord,
  urlTokens,
  properNounPhrases,
  temporalTokens,
  NAMED_TECH,
  CREDENTIAL_WORDS,
} from '../cv-assistant/cv-assistant-rewrite';
import type { CvBuilderChatFacts } from './cv-builder-chat.facts';
import type { CvBuilderChatModelOutput } from './cv-builder-chat.schema';
import { diagnosisProseLicense } from './cv-builder-diagnosis';

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

/** deterministic, seedable variant pick — the gate stays PURE (no Math.random; same model output →
 *  same served copy, so replays/tests are stable). Different turns rotate naturally via the seed. */
function pickVariant(variants: readonly string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return variants[Math.abs(h) % variants.length];
}

const refusalHint = (l: Lang, gaps: string[]): string =>
  gaps.length ? gapHint(l, gaps[0]) : l === 'vi' ? 'phần này' : 'this part';

// Warm refusal copy (was ONE fixed template — measured as the top "robot" complaint on refusal
// turns). Every variant: DIGIT-FREE, no tech/org/temporal token, names the first detected gap, and
// ends in a question so `ensureAskBack` never stacks a second ask on top (no double-ask nag).
function proseRefusal(l: Lang, gaps: string[], seed: string): string {
  const hint = refusalHint(l, gaps);
  const variants =
    l === 'vi'
      ? [
          `Chỗ này mình chưa dám viết vì chưa có chi tiết thật từ bạn — bạn kể mình nghe thêm về ${hint} được không?`,
          `Mình không muốn ghi vào CV điều bạn chưa xác nhận đâu. Bạn cho mình con số hoặc chi tiết thật về ${hint} nhé?`,
          `Khoan đã — viết vậy là mình đoán mất rồi. Bạn chia sẻ cụ thể về ${hint} giúp mình được không?`,
          `Phần đó cần dữ kiện thật của bạn thì viết mới đáng tin — ${hint} cụ thể là gì vậy?`,
        ]
      : [
          `I'd rather not guess on that — could you tell me a bit more about ${hint}?`,
          `I don't want to put anything in your CV you haven't confirmed. What's the real number or detail about ${hint}?`,
          `Hold on — writing that would be guessing. Can you share the specifics about ${hint}?`,
        ];
  return pickVariant(variants, seed);
}

// `groundCvChat` always calls `groundCvRewrite` with `needs_detail: []`, so its verdict can only fail
// as UNGROUNDED here — the NEEDS_DETAIL arm was unreachable and has been dropped.
function editRefusal(l: Lang, gaps: string[], seed: string): string {
  const hint = refusalHint(l, gaps);
  const variants =
    l === 'vi'
      ? [
          `Bản sửa đó có chi tiết mình chưa thấy bạn nói, nên mình chưa đưa vào CV đâu. Bạn xác nhận giúp mình về ${hint} được không?`,
          `Mình giữ nguyên chỗ đó đã — chưa đủ dữ kiện thật từ bạn để sửa cho đúng. Bạn kể mình nghe về ${hint} rồi mình đề xuất lại nhé?`,
          `CV chỉ nên chứa điều bạn chắc chắn — bạn cho mình con số hay chi tiết thật về ${hint} rồi mình viết lại ngay nhé?`,
        ]
      : [
          `That edit has details I haven't heard from you, so I left it out of your CV. Could you confirm ${hint} first?`,
          `I kept that part as it was — I don't have the real facts to change it yet. Could you tell me about ${hint} so I can propose it again?`,
          `Your CV should only say what you're sure of. What's the real number or detail about ${hint}?`,
        ];
  return pickVariant(variants, seed);
}

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

/** strip any raw URL from displayed prose (defense in depth — the prose gate already refuses a
 *  link the user never gave; this keeps even a licensed link out of the chat bubble).
 *  NEWLINES ARE PRESERVED: the old `\s{2,}` collapse flattened blank lines, which (a) mushed
 *  multi-paragraph answers into one blob and (b) moved a line-start "1." list marker the gate had
 *  allowed (enumeration relief is line-start-anchored) into mid-line — the served text then failed
 *  the very scan its raw message passed (measured live leak "1" ×2, 2026-07-21). */
function stripRawUrls(text: string): string {
  return text
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/[^\S\n]{2,}/g, ' ')
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
 * TWO-TIER benign-noun allow-list. The single old list was too permissive — it let a fabricated
 * percentage ("5 phần trăm"), a fabricated score ("5 điểm") and a fabricated count of the user's
 * RECORD ("5 công nghệ mạnh") ride in as "advice". The split distinguishes:
 *
 * WRITING_NOUN — a count of the WRITING OUTPUT (the advice/text itself, never the user): "2-3 phiên
 *   bản", "yếu ở 3 chỗ". Benign for a small integer/range (max ≤ 3).
 * ASK_NOUN — the model asking the user to PROVIDE one thing: "cho mình 1 công nghệ", "1 kết quả".
 *   Benign ONLY at exactly 1 — any count >1 is a claim about the user's record, which FACTS can
 *   contradict.
 *
 * Excluded from BOTH (never benign): `điểm`/score nouns (the diagnosis doctrine excludes score on
 * purpose), and the worded units `phần trăm`/`phần nghìn` (a `phần` that is a percent/per-mille unit,
 * not a "part"). Allow-list shape fails OPEN, so an unlisted noun just falls back to the gate (safe).
 * Anchored `^\s*` → the noun must sit IMMEDIATELY on the number.
 */
// Measured buy-backs (probe + live runs 2026-07-20), NARROWED after adversarial review caught the
// classifier hole ("3 mảnh kinh nghiệm", "2 thứ hạng cao" — a bare classifier joins a RECORD noun
// into a fabricated claim about the user):
//   - `mảnh` counts ONLY as the full measured phrase `mảnh thông tin`;
//   - `phần` (trăm/nghìn lookahead intact) counts ONLY phrase-final — "cần 2 phần:" — a following
//     letter-word ("3 phần kinh nghiệm") falls back to the wall;
//   - bare `thứ` is NOT listed at all ("2 thứ tiếng"/"thứ hạng" have no safe discriminator) — that
//     measured FP stays refused as an accepted residual;
//   - `điểm` counts ONLY inside `điểm mạnh`/`điểm chính` (a score is never a "điểm chính"), so the
//     bare-`điểm` score wall is intact;
//   - `kiểu` counts ONLY phrase-final ("có 3 kiểu:") — a following letter-word ("3 kiểu dự án" =
//     a record claim) falls back to the wall; `cách` counts ONLY as the full phrase `cách viết`.
const WRITING_NOUN =
  /^\s*(?:phiên bản|bản|gạch đầu dòng|dòng|câu|bullets?|chỗ|ý|động từ|mảnh thông tin|điểm mạnh|điểm chính|cách viết|kiểu(?=\s*(?:[^\p{L}\p{N}\s]|$))|phần(?!\s*(?:trăm|nghìn))(?=\s*(?:[^\p{L}\p{N}\s]|$))|versions?|lines?|sentences?|verbs?|wording)(?![\p{L}\p{N}])/iu;
const ASK_NOUN =
  /^\s*(?:công nghệ|công cụ|kết quả|chi tiết|thông tin|số liệu|con số|việc|mục|phần(?!\s*(?:trăm|nghìn))|technolog(?:y|ies)|tools?|results?|details?|things?|parts?)(?![\p{L}\p{N}])/iu;

/**
 * Is this ungrounded number a BENIGN writing-craft quantity the prose gate must NOT read as
 * fabrication? Mirrors the diagnosis doctrine (`isBenignQuantity`, diagnosis-grounding.ts). `token`
 * is the NFKC-folded, space-stripped number token; `before`/`after` are the slices of the (NFKC-
 * folded) text around the raw match.
 *
 * Benign iff a UNITLESS integer/range (a unit like `%`/`x`/`k`/`giờ`/`năm` is folded into `token` by
 * NUMBER_TOKEN_RE and fails the `^\d{1,2}$` shape) AND one of:
 *   - max value ≤ 3 AND a WRITING_NOUN is adjacent (a count of the text), OR
 *   - value is exactly 1 (not a range) AND an ASK_NOUN is adjacent (asking for one thing).
 * Otherwise NOT benign (stays gated) — so a fabricated %, score, salary or record-count cannot pass.
 */
function isBenignCvQuantity(before: string, after: string, token: string): boolean {
  const range = token.match(/^(\d{1,2})-(\d{1,2})$/);
  // pure integer or pure integer-range only. A unit/decimal/3+-digit token ("40%", "3.5", "100") is
  // never an advice count → not benign (stays gated).
  if (!range && !/^\d{1,2}$/.test(token)) return false;
  const values = range ? [Number(range[1]), Number(range[2])] : [Number(token)];
  if (values.some((n) => n < 1)) return false;
  if (/[\d/]$/.test(before)) return false; // the other half of a scale — "3/5", or a split larger number
  if (/^\s*[/%]/.test(after)) return false; // a rate/scale continues after the number — "5/10", "5 %"
  // enumeration marker "1)" / "1." opening a line of the advice list (measured live kills: two
  // shortened versions served as "1) … 2) …" and "1. … 2. …"). The ordinal asserts nothing about
  // the user; any number INSIDE the item is still its own gated token. Line-start only — an "(x2)"
  // multiplier or a sentence-final "đạt 2." has text before the digit on its line and stays
  // behind the wall. (A decimal "1.5" tokenizes with its fraction, so it never reaches here.)
  if (!range && values[0] <= 9 && /^(?:\)|\.(?:\s|$))/.test(after) && /(?:^|\n)\s*$/.test(before))
    return true;
  // TIER 1 — a count of the WRITING OUTPUT (describes the advice/text, not the user): max ≤ 3.
  if (Math.max(...values) <= 3 && WRITING_NOUN.test(after)) return true;
  // TIER 2 — the model asking the user to PROVIDE one thing: exactly 1, never a range.
  if (!range && values[0] === 1 && ASK_NOUN.test(after)) return true;
  return false;
}

/**
 * The first token in `text` that asserts a fact the user never licensed, or null. `licensed` is the
 * user's own words + the original focused text + the user's own target role, ALREADY NFKC-folded. Any
 * ungrounded number / tech / url / entity / credential / temporal token → this fires. ONE deliberate
 * relief (Slice-4 tuning, measured against the harness): a benign writing-craft quantity
 * ({@link isBenignCvQuantity}) is NOT a fabrication and passes. Reuses the shipped rewrite nets verbatim.
 */
export function firstUngroundedToken(text: string, licensed: string): string | null {
  const t = text.normalize('NFKC');
  const src = licensed; // already NFKC-folded by the caller
  const srcLower = src.toLowerCase();

  // (b) numbers — unit-aware, exact token ("40%" ≠ "40ms", "3-5 years" ≠ "5 years"). Iterate the same
  //     NUMBER_TOKEN_RE positionally so an ungrounded token can be checked for the benign-advice shape.
  const allowedNumbers = new Set(numberTokens(src));
  for (const m of t.matchAll(NUMBER_TOKEN_RE)) {
    const norm = normalizeNumberToken(m[0]);
    if (!/\d/.test(norm) || allowedNumbers.has(norm)) continue;
    const at = m.index ?? 0;
    if (isBenignCvQuantity(t.slice(0, at), t.slice(at + m[0].length), norm)) continue;
    return m[0].trim();
  }
  // fail CLOSED on non-ASCII Nd glyphs the ASCII scan above can't read (a fabricated metric is never
  // "benign" — this arm is untouched by the advice allowance).
  const nonAscii = firstNonAsciiDigitRun(t);
  if (nonAscii !== null) return nonAscii;

  // (c) fabricated SPECIFIC tech.
  for (const tech of NAMED_TECH) if (hasWord(t, tech) && !hasWord(src, tech)) return tech;
  // (d) fabricated URL / domain.
  for (const url of urlTokens(t)) if (!srcLower.includes(url)) return url;
  // (f) fabricated multi-word proper-noun (employer / org / product). ONE narrow relief: an edge
  // "CV" is the product-domain word, not an org — "CV Business Analyst" / "Frontend Developer CV"
  // (the ALL-CAPS acronym joining the licensed role into one phrase, both measured live FPs)
  // assert nothing beyond their licensed remainder. Only the literal edge "CV" is stripped; a
  // fabricated org next to it ("CV Nova Dynamics", "Nova Dynamics CV") keeps an unlicensed
  // remainder and still refuses. A one-word remainder is matched on a WORD boundary, not
  // substring — "CV An" must not ride on "Data ANalyst".
  const restLicensed = (rest: string): boolean =>
    rest.includes(' ') ? srcLower.includes(rest) : hasWord(src, rest);
  for (const phrase of properNounPhrases(t)) {
    const pl = phrase.toLowerCase();
    if (srcLower.includes(pl)) continue;
    if (pl.startsWith('cv ') && restLicensed(pl.slice(3))) continue;
    if (pl.endsWith(' cv') && restLicensed(pl.slice(0, -3))) continue;
    return phrase;
  }
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

  // licensed corpus = the user's OWN turns + the original focused text + their OWN target role ONLY
  // (never the assistant's). target_role is the user's stated goal, so naming it back ("cho vị trí
  // Full-stack Developer") is not invention; a DIFFERENT invented title stays uncovered and caught.
  const licensed = (
    candidateSaid +
    ' ' +
    (facts.focus?.current_text ?? '') +
    ' ' +
    (facts.target_role ?? '')
  ).normalize('NFKC');

  // TWO-CORPUS: the diagnosis findings license PROSE (the message) ONLY. They are digit-stripped at
  // the source (cv-builder-diagnosis.ts), so this can never widen the number-wall. The edit corpus
  // (groundCvRewrite below) and the suggestion chip KEEP `licensed`, so a tech/credential the scan
  // says the user is MISSING can be DISCUSSED here but never inserted into the CV or a clickable chip.
  const diagnosisProse = facts.diagnosis
    ? diagnosisProseLicense(facts.diagnosis).normalize('NFKC')
    : '';
  const proseLicensed = diagnosisProse ? licensed + ' ' + diagnosisProse : licensed;

  // 2) prose gate — any ungrounded fact token → refuse, and NEVER echo the fabricating message.
  if (firstUngroundedToken(p.message, proseLicensed) !== null) {
    return {
      answer: proseRefusal(l, gaps, p.message),
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
        answer: editRefusal(l, gaps, p.message),
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
      // NOTE (two-corpus residual): the diagnosis prose is kept OUT of this edit corpus (facts:
      // [licensed] above), so a tool the scan says the user is MISSING is never *licensed* for an
      // edit. It can still be inserted only if the model COPIES it into `after` AND it slips
      // groundCvRewrite's shared NAMED_TECH net (which omits the long tail: cypress, playwright…).
      // That is the pre-existing NAMED_TECH incompleteness, not specific to diagnosis — the model
      // could invent such a token in any edit. It is soft-guarded by the prompt ("never move a
      // skill/tool named here into the CV unless the user themselves confirms it") and, across the
      // live harness runs, the model discusses the tool and asks the user to confirm instead of
      // inserting it. A heuristic denylist over the diagnosis text was tried and reverted: it cannot
      // tell a tool (Cypress) from a common CV acronym (UI/UX, front-end) without a full gazetteer,
      // so it over-refused ubiquitous terms. Closing the tail belongs in the shared rewrite gate.
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
      answer: editRefusal(l, gaps, p.message),
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
