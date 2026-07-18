import { CvBuilderChatFacts } from './cv-builder-chat.facts';
import { NAMED_TECH, hasWord } from '../cv-assistant/cv-assistant-rewrite';

/**
 * The conversation BRAIN of the CV-builder companion (PURE — no LLM, no IO). Mirrors the mechanism
 * proven in `diagnosis-chat/conversation-state.ts` (memory over the WIDE history window + a
 * deterministic pre-LLM router + a one-shot ask-tracking slot), adapted to the CV-builder domain:
 * instead of "role/deadline", the thing worth remembering is WHICH bullet-writing gap
 * (`action`/`tech`/`result` — see `cv-assistant.ts`) the candidate just supplied detail for, so the
 * companion never asks for the same thing twice.
 *
 *  - extractConversationState: ONE chronological pass over history + the current question. The
 *    only forbidden failure is a WRONG capture (recording a gap the user did not actually answer);
 *    a MISSED capture only costs one re-ask, never a wrong fact. `active_field_path` is left null
 *    here on purpose: `field_path` is an opaque FE-owned id (`cvbuilder:projects[0].bullets[0]`)
 *    that is never restated in natural language, so there is no honest way to derive a REAL one from
 *    prose — `buildTurnContext` (which holds `facts`) is the only place with a truthful source
 *    (`facts.focus.field_path`), and it fills the default in.
 *  - routeIntent: entire-message-match canned routes (greeting/thanks/meta) guarded by DOMAIN_HINT,
 *    same discipline as diagnosis-chat — misrouting a real question as canned is the dangerous
 *    failure, so every canned route requires the WHOLE message to be the greeting/thanks form (meta
 *    is also length-capped). Everything else is verb-regex routed; unmatched falls to `write`
 *    (this file's equivalent of diagnosis-chat's `advice` catch-all).
 *  - buildTurnContext: the single entry point the service will call (wired in Task 2.3) — state +
 *    intent + the canned short-circuit + the `{{context}}` block + `ask` (Task 2.2's
 *    `askDirective` — null on a canned turn).
 *  - askDirective / ensureAskBack: the proactive ask-ONE-gap loop, mirroring
 *    `diagnosis-chat/conversation-state.ts`'s proven mechanism. Measured there: a directive alone
 *    ("ask when you don't know X") was obeyed only ~1 of 4 turns — the model answers well and then
 *    drops the closing question. So CODE decides WHEN to ask (`askDirective`, gated on intent +
 *    `facts.focus.gaps` + not-already-answered/asked), and the LLM only phrases it; `ensureAskBack`
 *    is the backstop that appends the standard question if the served answer carries no `?` at all.
 */

export interface CvBuilderConversationState {
  /** A role the candidate RESTATED in chat (verbatim); null = never restated. This is purely
   *  informational — `facts.target_role` (server-read) is the trusted source, so a missed/loose
   *  capture here costs nothing beyond one skipped personalization line. */
  target_role: string | null;
  /** The field/section the conversation is currently about. Always backfilled from
   *  `facts.focus?.field_path` by `buildTurnContext` (see the file docstring for why extraction
   *  alone can never derive a real one from prose). */
  active_field_path: string | null;
  /** Gaps the user has already supplied detail for THIS conversation (later turns can add more;
   *  never re-derived from scratch — it is a running log over the whole scan). */
  answered_gaps: Array<{ field_path: string; gap: string }>;
  /** EVERY gap the companion has asked about this session and NOT yet gotten an answer for — a
   *  CUMULATIVE outstanding set, deduped by gap KIND. One-shot per kind: a gap in here is never
   *  re-asked (asking twice is nagging). A gap is ADDED when an assistant turn asks it and REMOVED
   *  when the user answers it. A single slot was the old shape and it re-armed a nag: with 2+ open
   *  gaps, a newer ask overwrote the older dodged one, so the older gap looked un-asked and got
   *  re-asked forever (result→tech→result…). Sticky across turns that do not resolve an entry. */
  asked_gaps: Array<{ field_path: string; gap: string }>;
}

export type CvBuilderIntent =
  | 'greeting'
  | 'thanks'
  | 'meta'
  | 'write'
  | 'add_metric'
  | 'shorten'
  | 'ask_what_to_write'
  | 'explain'
  | 'recall';

export interface CvBuilderTurnContext {
  state: CvBuilderConversationState;
  intent: CvBuilderIntent;
  /** Non-null → serve this verbatim and skip the LLM entirely. */
  canned: string | null;
  /** Rendered into the prompt's `{{context}}` injection point; never empty. */
  contextBlock: string;
  /** The code-computed ask-back decision for this turn (see `askDirective`) — null when nothing
   *  qualifies, or the turn was served canned. The service uses it for `ensureAskBack` (Task
   *  2.3): the model cannot be trusted to obey a directive alone. */
  ask: { field_path: string; gap: string } | null;
}

export type HistoryMessage = { role: 'user' | 'assistant'; content: string; at?: string };

// ── the gap-ask/answer mechanism ─────────────────────────────────────────────────────────────────

/** the 3 bullet-writing gaps this file's ask-tracking currently covers — see `cv-assistant.ts`'s
 *  `BulletGap`. ponytail: summary gaps (`role`/`strength`/`evidence`) are NOT covered by
 *  {@link ASKED_GAP_RE} yet — a summary-focused ask just never gets auto-captured (fail-soft: a
 *  missed capture, never a wrong one). Add named groups here + in the regex when that ships. */
type BulletGapAsk = 'result' | 'tech' | 'action';

/** No real `field_path` can be recovered from prose (see file docstring) — this stamps the
 *  placeholder onto `asked_gaps`/`answered_gaps` entries so the field stays a `string` per the
 *  interface; `active_field_path` itself is left null (never set to this placeholder) so a genuine
 *  `facts.focus.field_path` default in `buildTurnContext` is never shadowed by a meaningless value. */
const UNKNOWN_FIELD = '(unspecified field)';

/**
 * Did an assistant turn ask about ONE specific bullet gap? Named capture groups identify WHICH gap
 * fired. CROSS-TASK COUPLING: authored here (Task 2.1); Task 2.2's `ASK_COPY` table MUST phrase its
 * ask-back copy to match one of these branches, or the one-shot capture-consumes-ask mechanism
 * silently stops working. Wide on purpose — matches the MODEL's own paraphrase of a gap-ask, not
 * only canned copy (a missed detection here just means one extra re-ask, never a wrong capture).
 * Digit-free and `?`-anchored per the replay-safety rule: this phrasing replays into history as
 * assistant text on the next turn, so it must never itself contain a number.
 */
const ASKED_GAP_RE =
  /(?<result>(?:kết\s*quả|hiệu\s*quả|đo\s*được|con\s*số(?:\s*cụ\s*thể)?|impact|result|outcome)[^.!?\n]{0,40}\?)|(?<tech>(?:công\s*nghệ|dùng\s*(?:công\s*cụ|framework|ngôn\s*ngữ)|stack|tech(?:nology)?|tool)[^.!?\n]{0,40}\?)|(?<action>(?:đã\s*làm\s*(?:gì|những\s*gì)|vai\s*trò\s*của\s*bạn|bạn\s*đảm\s*nhận|what\s*did\s*you\s*do|your\s*role)[^.!?\n]{0,40}\?)/iu;

function askedGapFrom(text: string): BulletGapAsk | null {
  const m = ASKED_GAP_RE.exec(text);
  if (!m?.groups) return null;
  if (m.groups.result) return 'result';
  if (m.groups.tech) return 'tech';
  if (m.groups.action) return 'action';
  return null;
}

/** a number next to a unit/metric ("40%", "200ms", "2x", "10k users") — the same shape
 *  `cv-assistant.ts` uses to detect a quantified result, kept LOCAL/self-contained rather than
 *  imported so this pure state module stays decoupled from that gap-analyzer's internals.
 *  Trailing boundary is the Unicode lookahead, not `\b` — JS `\b` is ASCII-only and never fires
 *  right after a Vietnamese diacritic vowel, the same pitfall diagnosis-chat's ROLE_WORD documents.
 *  Bare TIME units (`năm/giờ/ngày/tuần/tháng`, `hours/days/weeks/months`) are deliberately EXCLUDED —
 *  a duration ("tầm 2 tuần nữa") is a project timeframe, not a measured result, and unanchored they
 *  false-captured a time/deferral dodge as an answered `result` gap. A genuine time-based result
 *  ("giảm 2 giờ build") still gets caught via RESULT_CUE_RE's "giảm" cue below. */
const METRIC_RE = /\d+(?:\.\d+)?\s?(?:%|x|k|ms|s|gb|mb|users?|reqs?|requests?)(?![\p{L}\p{N}])/iu;
const RESULT_CUE_RE =
  /giảm|tăng|cải\s*thiện|tiết\s*kiệm|rút\s*ngắn|gấp\s*đôi|reduced|increased|saved|improved|grew|doubled|decreased/iu;
/** Unicode lookarounds, not `\b` — several verbs end in a diacritic vowel ("thiết kế", "tự động
 *  hoá") where `\b` never fires (see METRIC_RE's note above). */
const ACTION_VERB_ANSWER_RE =
  /(?<![\p{L}\p{N}])(?:xây|triển\s*khai|tạo|thiết\s*kế|phát\s*triển|tối\s*ưu|dẫn\s*dắt|ra\s*mắt|chuyển\s*đổi|tự\s*động\s*hoá|built|implemented|created|designed|developed|shipped|deployed|led|optimized|refactored|migrated|automated|launched)(?![\p{L}\p{N}])/iu;

/** Deferral guard for the `action` gap ONLY (see {@link answersGap} for why the other two gaps need
 *  no dodge guard at all). `result` is already fenced by METRIC_RE/RESULT_CUE_RE and `tech` by the
 *  NAMED_TECH gazetteer, so a deferral for those simply lacks a metric / a known tech and never
 *  captures — no dodge regex required. Only `action`'s ACTION_VERB_ANSWER_RE is loose enough that an
 *  incidental verb inside a deferral ("thôi mình tạo cái khác sau" → "tạo") would false-capture.
 *
 *  This matches ONLY unambiguous deferral markers, each anchored so it can't fire inside a genuine
 *  answer that merely mentions the same words:
 *  - `để (sau|mai|lúc khác|khi khác)` — NOT bare `để … đó` ("để đó cho anh xem" = "there it is, take a
 *    look" is a real answer, not a deferral).
 *  - `khỏi (cần|phải)` — "no need to" is a deferral; bare `khỏi` alone is not, and `khỏi lo` ("no
 *    worries") is deliberately left OUT of the companion list: a standalone "khỏi lo" carries no
 *    action verb so ACTION_VERB_ANSWER_RE never even fires on it (nothing to wrongly suppress), while
 *    "… xong rồi, khỏi lo" (a real answer with a reassurance tag) DOES carry one and must capture.
 *  - `hỏi ai đó (đã|xem|thử)` / `(mình) (nghĩ|coi|xem) (lại|đã)` — "ask/think first" idioms restored
 *    (e.g. "để hỏi sếp đã", "để mình coi đã") — clear deferrals, not real answers.
 *  - leading `^\s*thôi\b` (not the compound "thôi thúc") — "thôi" is a deferral ONLY when it LEADS the
 *    reply ("nah, …"); a sentence-final limiting-particle "thôi" ("tạo dashboard thôi" = "I just made
 *    a dashboard") is a REAL answer and must not match — the root-cause bug of the prior rounds.
 *  - `chưa (có|biết|xong|đâu)` — requires a deferral continuation; a bare "chưa" is a common hedge
 *    inside a genuine answer.
 *  - removed entirely: bare `không cần` (fires inside "đã tạo dashboard, không cần thư viện ngoài" — a
 *    real answer) and bare `cái khác` (fires inside "tạo dashboard với vài cái khác nữa" — more real
 *    work, not a deferral).
 *
 *  ponytail: the action gap is the fuzziest of the three signals — verb-in-answer vs. verb-in-deferral
 *  is inherently ambiguous prose, not a clean-cut regex problem. This guard covers the clear,
 *  unambiguous idioms named by review; any residual edge phrasing that still slips through is a
 *  Slice-4 harness-tuning item, not a safety concern — `groundCvChat`'s anti-fabrication gate blocks
 *  all fabrication regardless of what this guard misses (a missed deferral only costs one wrong-topic
 *  capture that a later correction turn overwrites, never a fabricated CV claim). */
const ACTION_DEFERRAL_RE =
  /để\s+(?:sau|mai|lúc\s+khác|khi\s+khác)|khỏi\s+(?:cần|phải)|hỏi\s+\S+\s+(?:đã|xem|thử)|(?:mình\s*)?(?:nghĩ|coi|xem)\s*(?:lại|đã)|^\s*thôi\b(?!\s+thúc)|\bskip\b|\blater\b|\bnevermind\b|chưa\s*(?:có|biết|xong|đâu)/iu;

/** Does this reply name a KNOWN technology from `NAMED_TECH` (the same curated gazetteer
 *  `groundCvRewrite`'s anti-fabrication gate arm (c) uses)? Deliberately NOT "any capitalized
 *  token" — that flagged a person's name/honorific ("Nam", "Anh") as tech. A real but obscure tech
 *  outside the gazetteer just costs one re-ask (never a wrong capture), which is the safe direction. */
function looksLikeTechAnswer(text: string): boolean {
  return NAMED_TECH.some((tech) => hasWord(text, tech));
}

/** Does this reply plausibly supply the detail for the gap that was just asked about? Each gap is
 *  gated by its OWN precise answer-signal — there is NO blanket dodge short-circuit (the prior rounds'
 *  root-cause defect: an unanchored dodge regex checked first discarded genuine answers that merely
 *  contained a stray token like a sentence-final "thôi"). A deferral for `result`/`tech` already
 *  fails to capture because it carries no metric / result-cue / known tech, so no dodge guard is
 *  needed there. Only `action` needs one: ACTION_VERB_ANSWER_RE is loose enough that an incidental
 *  verb inside a deferral would false-capture, so the action branch (and ONLY it) subtracts
 *  {@link ACTION_DEFERRAL_RE}. Forbidden failure is a WRONG capture; a missed one only costs a re-ask. */
function answersGap(text: string, gap: BulletGapAsk): boolean {
  if (gap === 'result') return METRIC_RE.test(text) || RESULT_CUE_RE.test(text);
  if (gap === 'tech') return looksLikeTechAnswer(text);
  return ACTION_VERB_ANSWER_RE.test(text) && !ACTION_DEFERRAL_RE.test(text); // 'action'
}

// ── the ask-back condition (code decides WHEN, mirrors diagnosis-chat's askDirective) ────────────

/** Intents where the candidate is asking for writing help — the only shapes where proactively
 *  asking for a missing bullet detail is caring, not noise. A `shorten`/`explain`/`recall` turn
 *  gets no ask: asking there would be a non-sequitur. */
const ASK_ELIGIBLE_INTENTS: ReadonlySet<CvBuilderIntent> = new Set([
  'write',
  'add_metric',
  'ask_what_to_write',
]);

/** Which gap to surface first when the focused bullet is missing more than one: result (the
 *  single strongest CV-writing signal) beats action, which beats tech.
 *  ponytail: summary gaps (`role`/`strength`/`evidence`) are deliberately OUT of this list for v1
 *  — {@link ASKED_GAP_RE} and `ASK_COPY` below don't cover them yet either (same scope as the file
 *  docstring's {@link BulletGapAsk} note). Add a gap here only together with a matching
 *  `ASKED_GAP_RE` branch and `ASK_COPY` entry, never one without the others. */
const ASK_PRIORITY: BulletGapAsk[] = ['result', 'action', 'tech'];

/**
 * Should this turn proactively ask for ONE missing bullet-writing detail, and which? Measured on
 * the sibling diagnosis-chat companion: telling the model "ask when you don't know X" got obeyed
 * ~1 of 4 turns — so code decides WHEN here too; the LLM only phrases via `ensureAskBack`.
 *
 * "Already answered/asked" is judged by gap KIND only (`state.answered_gaps`/`state.asked_gaps`),
 * never per-field — see the file docstring's `answered_gaps` note for why a real field-level
 * comparison isn't possible (the real `field_path` is an opaque FE id never restated in prose).
 * `asked_gaps` is the FULL outstanding set, not one slot: checking the whole set is what stops a
 * second gap's ask from re-arming a nag for an earlier dodged one (the bug this shape fixes).
 * ponytail (Slice-4 harness-tuning item, not a safety concern): this means once the user answers a
 * gap KIND, it is not re-asked for the rest of the session even on a different field. The natural
 * suppressor is that `facts.focus.gaps` is recomputed from the live draft every turn — once a
 * bullet is actually improved the gap disappears from FACTS on its own, so the common case
 * self-heals without this function ever needing to know which field was involved; `groundCvChat`'s
 * anti-fabrication gate blocks fabrication regardless of what this proactive nicety misses.
 */
export function askDirective(
  state: CvBuilderConversationState,
  intent: CvBuilderIntent,
  facts: CvBuilderChatFacts,
): { field_path: string; gap: string } | null {
  if (!ASK_ELIGIBLE_INTENTS.has(intent)) return null;
  const focus = facts.focus;
  if (!focus) return null;
  const answeredKinds = new Set(state.answered_gaps.map((g) => g.gap));
  const askedKinds = new Set(state.asked_gaps.map((g) => g.gap));
  for (const gap of ASK_PRIORITY) {
    if (!focus.gaps.includes(gap)) continue;
    if (answeredKinds.has(gap)) continue;
    if (askedKinds.has(gap)) continue; // already asked this session (answered or not) — never nag
    return { field_path: focus.field_path, gap };
  }
  return null;
}

// ── target-role restatement (informational only — see the interface doc) ───────────────────────

const ROLE_RE =
  /(?:nhắm|target(?:ing)?|ứng\s*tuyển|apply(?:ing)?)\s+(?:tới\s+|vào\s+)?(?:vị\s*trí\s+|role\s+|for\s+(?:a\s+|an\s+)?)?([^\n,.;:!?(]{2,60})|vị\s*trí\s+([^\n,.;:!?(]{2,60})/iu;
const ROLE_TAIL_RE =
  /\s+(?:và|với|trong|nhé|nha|thì|luôn|rồi|nữa|thôi|and|with|in|but|or)(?![\p{L}\p{N}])[\s\S]*$/iu;
const ROLE_REJECT_RE = /(?<![\p{L}])(?:nào|gì|đâu|sao|which|what|cv|resume)(?![\p{L}])/iu;

function roleFrom(text: string): string | null {
  const m = ROLE_RE.exec(text);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? '').replace(ROLE_TAIL_RE, '').trim().replace(/\s+/g, ' ');
  if (raw.length < 2 || raw.length > 40) return null;
  if (ROLE_REJECT_RE.test(raw)) return null;
  return raw;
}

// ── state extraction ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the structured state out of the conversation. One chronological pass. Every asked-but-unanswered
 * gap accumulates in `asked_gaps` (deduped by kind) and is STICKY (persists across later turns), so a
 * second gap's ask can never make an earlier dodged one look un-asked and re-arm a nag. Only the turn
 * IMMEDIATELY after an ask gets a capture attempt — later turns never retroactively consume a stale
 * ask, so a topic change can never be misread as an answer several turns later. A captured answer both
 * records into `answered_gaps` AND removes that kind from `asked_gaps` (it's resolved, not outstanding).
 */
export function extractConversationState(
  history: HistoryMessage[],
  question: string,
): CvBuilderConversationState {
  const state: CvBuilderConversationState = {
    target_role: null,
    active_field_path: null,
    answered_gaps: [],
    asked_gaps: [],
  };
  let justAskedGap: { field_path: string; gap: BulletGapAsk } | null = null;

  const readUserText = (text: string): void => {
    if (justAskedGap && answersGap(text, justAskedGap.gap)) {
      // the answer CONSUMES the ask — record it AND drop it from the outstanding set (resolved,
      // one-shot, never nag on a captured gap). Dodge does NOT enter here → the gap stays outstanding.
      state.answered_gaps.push({ field_path: justAskedGap.field_path, gap: justAskedGap.gap });
      const answered = justAskedGap.gap;
      state.asked_gaps = state.asked_gaps.filter((g) => g.gap !== answered);
    }
    const role = roleFrom(text);
    if (role) state.target_role = role;
    justAskedGap = null; // only the turn right after an ask gets a capture attempt
  };

  for (const m of history) {
    if (m.role === 'assistant') {
      const gap = askedGapFrom(m.content);
      if (gap) {
        // ADD to the outstanding set (dedupe by KIND); older outstanding gaps stay put.
        if (!state.asked_gaps.some((g) => g.gap === gap)) {
          state.asked_gaps.push({ field_path: UNKNOWN_FIELD, gap });
        }
        justAskedGap = { field_path: UNKNOWN_FIELD, gap };
      } else {
        // this turn did not ask — no immediate-capture window opens; the outstanding set is left
        // untouched (sticky) until a capture resolves an entry.
        justAskedGap = null;
      }
    } else {
      readUserText(m.content);
    }
  }
  readUserText(question);
  return state;
}

// ── intent router ────────────────────────────────────────────────────────────────────────────────

/** Any of these means the message carries real CV payload — never canned. */
const DOMAIN_HINT =
  /cv|bullet|dự\s*án|project|kinh\s*nghiệm|experience|summary|tóm\s*tắt|resume|hồ\s*sơ|gap|kỹ\s*năng|skill|viết|sửa|rewrite|edit|fix|section|mục|câu|đoạn/iu;

/** The ENTIRE message must be the greeting — "chào, CV mình sao rồi" falls through to the LLM
 *  (the trailing content breaks the `$` anchor before DOMAIN_HINT even needs to fire). */
const GREETING_RE =
  /^\s*(?:hi+|hello+|hey+|yo|alo+|helo+|hé\s*lô|lô|chào(?:\s+(?:bạn|bot|em|anh|chị|buổi\s+(?:sáng|chiều|tối)))?|xin\s+chào|good\s+(?:morning|afternoon|evening))\s*[!.~^\-_*]*\s*$/iu;

const THANKS_RE =
  /^\s*(?:cảm\s*ơn|cám\s*ơn|thank(?:s|\s+you)?|tks|thx|bye+|byebye|tạm\s+biệt)(?:\s+(?:bạn|bot|nhiều|nhìu|nhiu|nha|nhé|nghen|so\s+much|a\s+lot))*\s*[!.~]*\s*$/iu;

/** NOT entire-message anchored (a "who are you" opener can carry a real question after it) — the
 *  length cap + DOMAIN_HINT guard are what keep this safe, same discipline as diagnosis-chat. */
const META_RE =
  /(?:bạn|mày|you)\s*(?:là\s*(?:ai|gì|bot)|làm\s+được\s+(?:những\s+)?gì|giúp\s+được\s+gì|biết\s+làm\s+gì|có\s+thể\s+làm\s+(?:được\s+)?gì)|who\s+are\s+you|what\s+can\s+you\s+do|are\s+you\s+a\s+bot/iu;

const RECALL_RE =
  /(?:vừa|lúc|hồi|ban)\s+nãy[^\n]{0,40}(?:nói|bảo|khuyên|hỏi)|bạn\s+(?:có\s+)?nhớ|mình\s+(?:đã\s+|vừa\s+)?nói\s+(?:gì|là\s+gì)|nhắc\s+lại\s+(?:giúp|cho|dùm)|what\s+did\s+(?:you|i)\s+(?:just\s+)?say|do\s+you\s+remember|remind\s+me\s+what/iu;

const EXPLAIN_RE = /tại\s*sao|vì\s*sao|giải\s*thích|explain|why\s+(?:is|does|should|do)/iu;

const ADD_METRIC_RE =
  /thêm\s*(?:số\s*liệu|con\s*số|metric)|định\s*lượng|quantify|add\s*(?:a\s*)?(?:metric|number)|with\s+numbers?|đưa\s*(?:số\s*liệu|con\s*số)\s*vào/iu;

const SHORTEN_RE =
  /ngắn\s*(?:lại|hơn|gọn)?|rút\s*gọn|cô\s*đọng|súc\s*tích\s*hơn|shorten|make\s+(?:it|this)\s+(?:shorter|more\s+concise)|more\s+concise|trim\s+(?:it|this)/iu;

const ASK_WHAT_TO_WRITE_RE =
  /nên\s*viết\s*gì|viết\s*gì\s*(?:đây|bây\s*giờ)?|(?:chưa|không)\s*biết\s*viết\s*(?:gì|sao)|what\s+should\s+i\s+write|what\s+(?:to|do\s+i)\s+write|gợi\s*ý\s*(?:nội\s*dung|giúp)/iu;

export function routeIntent(question: string, facts: CvBuilderChatFacts): CvBuilderIntent {
  const q = question.trim();
  if (GREETING_RE.test(q) && !DOMAIN_HINT.test(q)) return 'greeting';
  if (THANKS_RE.test(q) && !DOMAIN_HINT.test(q)) return 'thanks';
  if (q.length <= 50 && META_RE.test(q) && !DOMAIN_HINT.test(q)) return 'meta';
  if (RECALL_RE.test(q)) return 'recall';
  if (EXPLAIN_RE.test(q)) return 'explain';
  if (ADD_METRIC_RE.test(q)) return 'add_metric';
  if (SHORTEN_RE.test(q)) return 'shorten';
  // asking "what should I write" only reads as its own intent when there IS a focused field to
  // write about; with no focus it is just a generic write/help request.
  if (ASK_WHAT_TO_WRITE_RE.test(q) && facts.focus !== null) return 'ask_what_to_write';
  return 'write';
}

// ── canned replies (code-authored — zero fabrication surface, zero latency) ──────────────────────

// Every line is digit-free and phrased so it never trips ASKED_GAP_RE when it replays into history
// as assistant text (no gap-ask keyword sits next to a "?").
export const CANNED: Record<'greeting' | 'thanks' | 'meta', { vi: string; en: string }> = {
  greeting: {
    vi: 'Chào bạn! Mình đang xem CV bạn đang chỉnh đây. Bạn muốn mình giúp viết lại đoạn nào, hay đang phân vân chỗ nào trong CV?',
    en: "Hey! I'm looking at the CV you're editing right now. Want help rewriting a section, or is there a part you're unsure about?",
  },
  thanks: {
    vi: 'Rất vui được giúp! Có phần nào khác trong CV bạn muốn mình xem tiếp không?',
    en: 'Happy to help! Anything else in your CV you want me to look at?',
  },
  meta: {
    vi: 'Mình là trợ lý viết CV của bạn. Mình chỉ dựa trên nội dung CV thật của bạn để gợi ý cách viết rõ hơn, mạnh hơn — không tự bịa số liệu hay chi tiết bạn chưa nói. Bạn muốn bắt đầu từ phần nào?',
    en: "I'm your CV-writing assistant. I only work from your own CV content to help you write it clearer and stronger — I never invent numbers or details you haven't told me. Where do you want to start?",
  },
};

// ── the shared entry point ───────────────────────────────────────────────────────────────────────

/**
 * Everything the service needs to run one intelligent turn: the state, the route, the canned
 * short-circuit, the context block that goes into the prompt's `{{context}}` injection point, and
 * the `ask` decision (Task 2.2's `askDirective` — null on a canned turn, since a canned reply is
 * served verbatim and never reaches `ensureAskBack`).
 */
export function buildTurnContext(
  facts: CvBuilderChatFacts,
  history: HistoryMessage[],
  question: string,
  language?: string,
): CvBuilderTurnContext {
  const state = extractConversationState(history, question);
  // extractConversationState can never derive a REAL field_path from prose (see file docstring) —
  // `facts.focus.field_path` is the only honest source, so it backfills whenever text found nothing.
  if (state.active_field_path === null) state.active_field_path = facts.focus?.field_path ?? null;

  const intent = routeIntent(question, facts);
  const lang: 'vi' | 'en' = language?.toLowerCase().startsWith('en') ? 'en' : 'vi';

  const canned =
    intent === 'greeting' || intent === 'thanks' || intent === 'meta' ? CANNED[intent][lang] : null;

  const lines: string[] = [
    'Known from this conversation (extracted by code — trust it, do not re-ask):',
    `- Active field: ${state.active_field_path ?? '(not specified)'}`,
    `- Target role (as restated in chat): ${
      state.target_role ?? "(not restated — use the CV's own target role)"
    }`,
  ];
  if (state.answered_gaps.length) {
    lines.push(
      `- Already answered in this conversation: ${state.answered_gaps
        .map((g) => g.gap)
        .join(', ')}`,
    );
  }

  const directives: string[] = [];
  if (intent === 'recall') {
    directives.push(
      'They are asking about something already said earlier in this conversation. Answer it plainly from the conversation text; no citation needed.',
    );
  }
  if (directives.length) lines.push('Directive:', ...directives.map((d) => `- ${d}`));

  const ask = canned === null ? askDirective(state, intent, facts) : null;
  return { state, intent, canned, contextBlock: lines.join('\n'), ask };
}

// ── the ask-back BACKSTOP (code appends what the model was told to ask and didn't) ──────────────

/** One standard question per gap × language, keyed by {@link BulletGapAsk}. CRITICAL COUPLING: each
 *  string here MUST be phrased so {@link ASKED_GAP_RE} matches it — these are literally the same
 *  vi phrasings this file's own tests already prove trigger the `result`/`tech`/`action` branches
 *  (see `ASKED_RESULT` and friends in the spec), so the round-trip is not a hope, it's reused
 *  working copy. Digit-free per the replay-safety rule (this text replays into history as
 *  assistant text on the next turn). */
const ASK_COPY: Record<BulletGapAsk, [string, string]> = {
  // [vi, en]
  result: ['Dự án đó bạn đo được kết quả gì chưa?', 'What was the measurable result of that?'],
  tech: ['Bạn dùng công nghệ gì cho phần này vậy?', 'What tech stack did you use for this?'],
  action: ['Bạn đã làm gì trong dự án đó vậy?', 'What did you do in that project?'],
};

/**
 * Measured on the sibling diagnosis-chat companion (live 25-turn probe): an ask Directive alone
 * was obeyed in only 1 of 4 turns it fired — the model answers well and then drops the closing
 * question. The WHEN is code's decision (`askDirective`), so the DO becomes code's backstop too:
 * if the served answer carries no question at all, append the standard one. Only for turns
 * `askDirective` actually fired on; never stacks a second question onto an existing one.
 */
export function ensureAskBack(
  answer: string,
  ask: { field_path: string; gap: string } | null,
  language?: string,
): string {
  if (!ask || answer.includes('?')) return answer;
  const copy = ASK_COPY[ask.gap as BulletGapAsk];
  if (!copy) return answer; // ponytail: no copy for this gap kind yet (v1 = bullet gaps only)
  const lang = language?.toLowerCase().startsWith('en') ? 1 : 0;
  return `${answer.trim()} ${copy[lang]}`;
}
