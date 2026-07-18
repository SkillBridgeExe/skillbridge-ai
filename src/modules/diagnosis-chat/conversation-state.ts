import { DiagnosisFacts } from './diagnosis-grounding';

/**
 * The conversation BRAIN of the CV-diagnosis advisor (PURE — no LLM, no IO).
 *
 * Why this exists: prompt-only companionship failed twice, measured. Told "ASK when you don't know
 * their role", the model asked 1 time in 25 adversarial turns — it cannot judge WHEN to ask, and it
 * flattens questions into offers. And its memory was the raw 10-message window: a role stated on
 * turn 1 fell off the cliff on turn 11. Both are conditions CODE can compute deterministically —
 * the same needs_detail pattern that already works in cv-assistant: code decides WHEN, the LLM only
 * phrases.
 *
 *  - extractConversationState: deterministic read of what the candidate already told us
 *    (target role, deadline) and what the advisor already asked (never nag twice). Runs over the
 *    WIDE history window (the platform loads more rows than the prompt shows), so memory survives
 *    beyond the 10-message prompt window.
 *  - routeIntent: deterministic pre-LLM router. Greetings / meta / thanks are answered by CODE
 *    (warm canned copy, zero latency, zero fabrication surface). Recall and JD-comparison turns
 *    keep the LLM but get an explicit directive. Everything else is a normal advice turn.
 *  - buildTurnContext: the single entry point the service AND the calibration harnesses share —
 *    a private mirror of this logic in a harness once drifted and measured the wrong release.
 *
 * Extraction is fail-SOFT by design: a missed role/deadline costs one personalization (state shows
 * "(not stated yet)"), never a wrong answer. Misrouting an intent is the only dangerous failure —
 * a canned greeting served over a real question — so every canned route requires the ENTIRE
 * message to be the greeting/thanks form, and meta is length-capped; anything ambiguous falls
 * through to the LLM.
 */

export interface DiagnosisConversationState {
  /** What role the candidate said they target — verbatim from THEIR message; null = never stated. */
  target_role: string | null;
  /** Their stated time budget/deadline, verbatim ("2 tuần", "cuối tháng 8"); null = never stated. */
  deadline: string | null;
  /** ISO timestamp of the row that set `deadline` (Wave 3 expiry) — null when the deadline came
   *  from the CURRENT question (fresh by definition) or the row carried no timestamp. */
  deadline_stated_at: string | null;
  /** The advisor already asked for the role — asking twice is nagging, not caring. */
  asked_role: boolean;
  /** The advisor already asked about their timeline. */
  asked_deadline: boolean;
}

export type DiagnosisIntent =
  | 'greeting'
  | 'thanks'
  | 'meta'
  | 'recall'
  | 'compare_jd'
  | 'what_you_know'
  | 'forget'
  | 'remember'
  | 'advice';

export interface DiagnosisTurnContext {
  state: DiagnosisConversationState;
  intent: DiagnosisIntent;
  /** Non-null → serve this verbatim and skip the LLM entirely (greeting/thanks/meta static copy,
   *  plus the COMPOSED memory-verb echoes — code-built from state, so still zero fabrication). */
  canned: string | null;
  /** Rendered into the prompt's context injection point; never empty (stable placeholder). */
  contextBlock: string;
  /** The code-computed ask-back order for this turn (also woven into contextBlock as a Directive).
   *  The service uses it for {@link ensureAskBack} — the model cannot be trusted to obey alone. */
  ask: 'role' | 'deadline' | null;
}

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ISO created_at of the persisted row — optional because harness/spec threads are synthetic.
   *  Only the deadline-expiry rule reads it; everything else stays timestamp-free. */
  at?: string;
}

// ── state extraction ─────────────────────────────────────────────────────────────────────────────

/** Captures run to the first punctuation; the tail is then trimmed at the first connective. */
const ROLE_PATTERNS: RegExp[] = [
  /(?:nhắm|target(?:ing)?)\s+(?:tới\s+|vào\s+)?(?:vị\s*trí\s+|role\s+)?([^\n,.;:!?(]{2,60})/iu,
  /(?:ứng\s*tuyển|apply(?:ing)?)\s+(?:vào\s+|cho\s+|vị\s*trí\s+|for\s+(?:a\s+|an\s+|the\s+)?)?([^\n,.;:!?(]{2,60})/iu,
  /vị\s*trí\s+([^\n,.;:!?(]{2,60})/iu,
  /(?:muốn|định|thích|sẽ)\s+làm\s+(?:về\s+)?([^\n,.;:!?(]{2,60})/iu,
  /(?:theo|làm)\s+(?:nghề|mảng|hướng)\s+([^\n,.;:!?(]{2,60})/iu,
  /(?:i\s+want\s+to\s+(?:be|become)|looking\s+for)\s+(?:a\s+|an\s+)?([^\n,.;:!?(]{2,60})/iu,
];

/** Words after which a role title is over ("AI Engineer và mình còn 2 tuần" → "AI Engineer").
 *  NOTE: JS `\b` is ASCII-only — it never fires after "và"/"nhé"/"ạ" — so the boundary is the
 *  explicit Unicode lookahead. */
const ROLE_TAIL =
  /\s+(?:và|với|trong|trước|sau|còn|chứ|nhé|nha|nghen|thì|mà|luôn|rồi|nữa|thôi|đã|không|ko|hả|à|ạ|á|vì|nên|hay|hoặc|and|with|in|before|but|or|so)(?![\p{L}\p{N}])[\s\S]*$/iu;

/**
 * The words IMMEDIATELY BEFORE a role pattern that flip its meaning: negation ("mình KHÔNG nhắm X
 * nữa"), hypothetical/deliberation ("nếu mình nhắm X thì sao?", "có nên nhắm X không?"), someone
 * else's role ("bạn mình nhắm X"). All were MEASURED shipping a wrong role as Known — the worst
 * failure this file has, because the prompt tells the model to TRUST the Known lines. Up to two
 * intervening words so the guard also covers the "vị trí X" sub-pattern ("KHÔNG nhắm vị trí X").
 * Fail-soft: a false hit costs one missed personalization, never a wrong one.
 */
const ROLE_PRE_GUARD =
  /(?:không|ko|hông|chưa|đừng|nếu|giả\s+sử|lỡ|nên|hay\s+là|bạn\s+(?:mình|em|tôi|tớ)|anh\s+mình|chị\s+mình|em\s+mình|nó)(?:\s+[\p{L}\p{N}]+){0,2}\s*$/iu;

/** A capture containing any of these is a question/place/junk, not a title. Unicode lookarounds,
 *  not `\b` — `\bgì\b` never matches ("ì" is not ASCII \w, so the boundary does not exist). */
const ROLE_REJECT =
  /(?<![\p{L}])(?:nào|gì|đâu|sao|which|what|where|cv|hồ\s*sơ|resume|bài\s*tập|xong|này|đó|đấy|kia|tuyển\s*dụng|khác|ở|tại)(?![\p{L}])/iu;

/** Lowercase titles still accepted when they contain a recognizable role word ("backend dev").
 *  Unicode word boundaries are load-bearing: without them "ai" matched inside "mai"/"dài" and
 *  shipped "mai mối" as a target role (measured). */
const ROLE_WORD =
  /(?<![\p{L}])(?:engineer|developer|dev|analyst|designer|tester|qa|qc|data|ai|ml|backend|back-end|frontend|front-end|fullstack|full-stack|devops|mobile|web|game|product|project|business|marketing|sales|scientist|architect|intern|fresher|junior|senior|manager|lead|pm|ba|hr|kế\s+toán|nhân\s+sự|lập\s+trình|kiểm\s+thử|phân\s+tích|thiết\s+kế)(?![\p{L}])/iu;

function cleanRole(capture: string): string | null {
  const role = capture.replace(ROLE_TAIL, '').trim().replace(/\s+/g, ' ');
  if (role.length < 2 || role.length > 40) return null;
  if (ROLE_REJECT.test(role)) return null;
  // A title either looks like one (has an uppercase letter — "Data Analyst") or contains a known
  // role word (lowercase chat register — "backend dev"). Anything else fails soft to null.
  if (!/\p{Lu}/u.test(role) && !ROLE_WORD.test(role)) return null;
  return role;
}

const DEADLINE_PATTERNS: RegExp[] = [
  /(?:còn|chỉ\s+còn|chỉ\s+có)\s*(?:đúng\s*)?(\d{1,3}\s*(?:tuần|ngày|tháng)(?:\s*(?:nữa|rưỡi))?)/iu,
  /(?:deadline|hạn\s+nộp|hạn\s+chót|nộp)[^\n.!?]{0,25}?(\d{1,3}\s*(?:tuần|ngày|tháng))/iu,
  /(?:trước|đến|tới)\s+((?:cuối\s+|đầu\s+|giữa\s+)?tháng\s+\d{1,2})/iu,
  // "(?!\s*\d)" — "cuối tháng 8" belongs to the pattern above; without the guard this one runs
  // LATER in the loop and would overwrite "cuối tháng 8" with the truncated "cuối tháng".
  /(tuần\s+sau|tuần\s+tới|tháng\s+sau|tháng\s+tới|ngày\s+mai|cuối\s+tuần(?:\s+này)?|cuối\s+tháng(?:\s+này)?)(?![\p{L}\p{N}])(?!\s*\d)/iu,
  /\b(\d{1,3}\s*(?:weeks?|days?|months?))\s*(?:left|remaining|to\s+go)\b/iu,
  /\bin\s+(\d{1,3}\s*(?:weeks?|days?|months?))\b/iu,
];

/** Did an assistant turn already ask this? Detected on the SERVED text (what history replays).
 *  Wide on purpose — the MODEL phrases the ask ("Bạn đang hướng tới công việc nào vậy?" has
 *  neither "vị trí" nor "role"); a missed detection here means nagging every turn (measured). */
const ASKED_ROLE_RE =
  /(?:vị\s*trí|role|position|công\s+việc|nghề|job|hướng\s+(?:tới|đến)|định\s+hướng|aiming)[^.!?\n]{0,40}\?|(?:nhắm|ứng\s*tuyển|target)[^.!?\n]{0,40}\?/iu;
const ASKED_DEADLINE_RE =
  /(?:bao\s+lâu|bao\s+nhiêu\s+(?:tuần|ngày|thời\s+gian)|khi\s+nào\s+nộp|deadline|hạn\s+nộp|còn\s+(?:bao\s+nhiêu|nhiều)\s+thời\s+gian|how\s+(?:long|much\s+time)|timeline)[^.!?\n]{0,40}\?/iu;

/** Leading fillers / trailing particles around a BARE answer ("chắc là data analyst quá"). */
const BARE_LEAD =
  /^(?:dạ|vâng|ừm?|uh|thì|là|chắc(?:\s+là)?|có\s+lẽ(?:\s+là)?|mình\s+(?:nghĩ\s+(?:là\s+)?|định\s+|muốn\s+)?|em\s+|kiểu(?:\s+như)?\s*|maybe|probably|i\s+think)\s+/iu;
const BARE_TAIL = /(?:\s*(?:quá|á|đó|đấy|nha|nhé|nhỉ|ạ|luôn|chăng|thôi|đi|ha|hen|\.|!|~))+$/iu;
const BARE_DEADLINE =
  /^(\d{1,3}\s*(?:tuần|ngày|tháng|weeks?|days?|months?))(?:\s*(?:nữa|thôi|left))?$/iu;

function stripBare(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 3; i++) t = t.replace(BARE_LEAD, '');
  return t.replace(BARE_TAIL, '').trim();
}

function roleFrom(text: string): string | null {
  let found: string | null = null;
  for (const re of ROLE_PATTERNS) {
    const m = re.exec(text);
    if (!m || typeof m.index !== 'number') continue;
    // The 30 chars before the match decide whether it MEANS a target role at all —
    // "mình KHÔNG nhắm X nữa" / "nếu mình nhắm X" / "bạn mình nhắm X" all shipped a wrong Known.
    const windowBefore = text.slice(Math.max(0, m.index - 30), m.index);
    if (ROLE_PRE_GUARD.test(windowBefore)) continue;
    const role = cleanRole(m[1]);
    if (role) found = role;
  }
  return found;
}

function deadlineFrom(text: string): string | null {
  let found: string | null = null;
  for (const re of DEADLINE_PATTERNS) {
    const m = text.match(re);
    if (m) found = m[1].trim().replace(/\s+/g, ' ');
  }
  return found;
}

/**
 * Read the structured state out of the conversation. `history` should be the WIDEST window the
 * caller has (the platform passes more rows than the prompt shows); `question` is this turn's
 * message, which may itself state the role/deadline. One chronological pass: later statements win,
 * and a short BARE reply right after the advisor's own ask ("Bạn nhắm vị trí nào?" → "AI Engineer")
 * counts as the answer even though it has no pattern anchor of its own.
 */
export function extractConversationState(
  history: HistoryMessage[],
  question: string,
): DiagnosisConversationState {
  const state: DiagnosisConversationState = {
    target_role: null,
    deadline: null,
    deadline_stated_at: null,
    asked_role: false,
    asked_deadline: false,
  };
  let justAskedRole = false;
  let justAskedDeadline = false;

  const readUserText = (text: string, at?: string): void => {
    // Wave 2 FORGET: nullify BEFORE extraction and stop — "quên vị trí AI Engineer đi" must not
    // re-capture the role from the forget sentence itself. The marker persists in history, so
    // this branch re-nullifies on every future re-scan: forgetting is durable by construction
    // (and later-wins still holds — a NEW statement after the marker sets the field again).
    const forget = parseForgetCommand(text);
    if (forget) {
      if (forget.role) state.target_role = null;
      if (forget.deadline) {
        state.deadline = null;
        state.deadline_stated_at = null;
      }
      justAskedRole = false;
      justAskedDeadline = false;
      return;
    }
    // TANGLED forget attempt (strict parse DECLINED — verb mid-sentence, mixed payload,
    // too long): skip extraction entirely, fail toward "don't capture". Running roleFrom
    // over "quên vị trí Data Analyst và sửa CV giúp mình với" re-asserted the exact role
    // the user tried to erase as newly-Known (probe-confirmed 2026-07-18) — a WRONG Known
    // is this file's one forbidden failure; a missed capture costs one personalization.
    // "đừng/chớ quên ..." is the opposite speech act (= remember) and stays capturable.
    if (LOOSE_FORGET_VERB_RE.test(text) && MEMORY_FIELD_RE.test(text)) {
      justAskedRole = false;
      justAskedDeadline = false;
      return;
    }
    const role = roleFrom(text);
    if (role) state.target_role = role;
    else if (justAskedRole) {
      const bare = stripBare(text);
      const bareRole = bare.length <= 40 ? cleanRole(bare) : null;
      if (bareRole) state.target_role = bareRole;
    }
    const deadline = deadlineFrom(text);
    if (deadline) {
      state.deadline = deadline;
      state.deadline_stated_at = at ?? null;
    } else if (justAskedDeadline) {
      const m = stripBare(text).match(BARE_DEADLINE);
      if (m) {
        state.deadline = m[1].trim().replace(/\s+/g, ' ');
        state.deadline_stated_at = at ?? null;
      }
    }
    justAskedRole = false;
    justAskedDeadline = false;
  };

  for (const m of history) {
    if (m.role === 'assistant') {
      justAskedRole = ASKED_ROLE_RE.test(m.content);
      justAskedDeadline = ASKED_DEADLINE_RE.test(m.content);
      if (justAskedRole) state.asked_role = true;
      if (justAskedDeadline) state.asked_deadline = true;
    } else {
      readUserText(m.content, m.at);
    }
  }
  // The current question carries no timestamp on purpose — a deadline stated THIS turn is fresh
  // by definition (deadline_stated_at stays null and the expiry rule never fires on it).
  readUserText(question);
  return state;
}

// ── deadline expiry (Wave 3 — deterministic, the "Dreaming" problem solved by code) ─────────────

/** Approximate day-span of a RELATIVE deadline phrase ("2 tuần" → 14). Returns null for phrases
 *  with no honest span ("cuối tháng 8", a named month) — we never guess a calendar date. */
const SPAN_RE = /(\d{1,3})\s*(tuần|ngày|tháng|weeks?|days?|months?)/iu;
const KEYWORD_SPANS: Array<[RegExp, number]> = [
  [/ngày\s+mai/iu, 1],
  [/tuần\s+(?:sau|tới)|cuối\s+tuần/iu, 7],
  [/tháng\s+(?:sau|tới)|cuối\s+tháng(?!\s*\d)/iu, 30],
];

export function deadlineSpanDays(deadline: string): number | null {
  const m = SPAN_RE.exec(deadline);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const base =
      unit.startsWith('tuần') || unit.startsWith('week')
        ? n * 7
        : unit.startsWith('tháng') || unit.startsWith('month')
          ? n * 30
          : n;
    return /rưỡi/iu.test(deadline) ? Math.round(base * 1.5) : base;
  }
  for (const [re, days] of KEYWORD_SPANS) if (re.test(deadline)) return days;
  return null;
}

/** True when the stated relative deadline has, by wall clock, already elapsed since the row that
 *  stated it. Fail-soft in every branch: no timestamp / no parseable span / current-turn statement
 *  → NOT stale (a wrongly-stale flag would make the advisor distrust a live deadline). */
export function deadlineStale(state: DiagnosisConversationState, now: Date): boolean {
  if (!state.deadline || !state.deadline_stated_at) return false;
  const span = deadlineSpanDays(state.deadline);
  if (span === null) return false;
  const stated = Date.parse(state.deadline_stated_at);
  if (Number.isNaN(stated)) return false;
  return now.getTime() - stated > span * 86_400_000;
}

// ── intent router ────────────────────────────────────────────────────────────────────────────────

/** Any of these means the message carries real CV payload — never canned. */
const DOMAIN_HINT =
  /cv|điểm|score|ats|gap|kỹ\s*năng|skill|jd|match|bullet|kinh\s*nghiệm|dự\s*án|sửa|học|interview|phỏng\s*vấn|resume|hồ\s*sơ|chẩn\s*đoán|đậu|lương|salary|tuyển|apply|role|vị\s*trí/iu;

/** The ENTIRE message must be the greeting — "chào, CV mình sao rồi" falls through to the LLM. */
const GREETING_RE =
  /^\s*(?:hi+|hello+|hey+|yo|alo+|helo+|hé\s*lô|lô|chào(?:\s+(?:bạn|bot|em|anh|chị|buổi\s+(?:sáng|chiều|tối)))?|xin\s+chào|good\s+(?:morning|afternoon|evening))\s*[!.~^\-_*]*\s*$/iu;

const THANKS_RE =
  /^\s*(?:cảm\s*ơn|cám\s*ơn|thank(?:s|\s+you)?|tks|thx|bye+|byebye|tạm\s+biệt)(?:\s+(?:bạn|bot|nhiều|nhìu|nhiu|nha|nhé|nghen|so\s+much|a\s+lot))*\s*[!.~]*\s*$/iu;

const META_RE =
  /(?:bạn|mày|you)\s*(?:là\s*(?:ai|gì|bot)|làm\s+được\s+(?:những\s+)?gì|giúp\s+được\s+gì|biết\s+làm\s+gì|có\s+thể\s+làm\s+(?:được\s+)?gì)|who\s+are\s+you|what\s+can\s+you\s+do|are\s+you\s+a\s+bot/iu;

const RECALL_RE =
  /(?:vừa|lúc|hồi|ban)\s+nãy[^\n]{0,40}(?:nói|bảo|khuyên|hỏi)|bạn\s+(?:có\s+)?nhớ|mình\s+(?:đã\s+|vừa\s+)?nói\s+(?:gì|là\s+gì|vị\s*trí)|nhắc\s+lại\s+(?:giúp|cho|dùm)|(?:nói|bảo)\s+gì\s+ấy\s+nhỉ|what\s+did\s+(?:you|i)\s+(?:just\s+)?say|do\s+you\s+remember|remind\s+me\s+what/iu;

const COMPARE_JD_RE =
  /so\s+sánh[^\n]{0,40}(?:jd|match|vị\s*trí|job)|(?:jd|match|job)[^\n]{0,30}(?:nào|which)|(?:hợp|phù\s+hợp)[^\n]{0,20}(?:jd|vị\s*trí|job)\s+nào|which\s+(?:jd|job|match)/iu;

// ── Wave 2 memory verbs (code-routed mirror/forget/remember — same misroute discipline) ─────────

/** The whole message must BE the mirror request — "bạn biết gì về ngành data?" fails the
 *  về-(mình|tôi|…) tail and falls through to the LLM. Checked BEFORE recall: RECALL_RE's
 *  "bạn nhớ" branch would otherwise swallow it. */
const WHAT_YOU_KNOW_RE =
  /^\s*(?:bạn|cậu|mày|em)?\s*(?:đang|còn)?\s*(?:nhớ|biết)\s+(?:được\s+)?(?:những\s+)?gì(?:\s+về\s+(?:mình|tôi|tớ|em|me))?\s*(?:không|ko|k|nào|vậy|thế|đó|nhỉ)?\s*\??\s*$|^\s*what\s+do\s+you\s+(?:know|remember)\s+about\s+me\s*\??\s*$/iu;

/** Prefix only — the router additionally requires roleFrom/deadlineFrom to CAPTURE something
 *  from the message, so "nhớ kỹ là JD này cần Docker nhé" (nothing capturable) reaches the LLM. */
const REMEMBER_RE =
  /^\s*(?:nhớ|ghi\s+nhớ|ghi\s+lại|lưu\s+lại|remember)\s+(?:giùm|dùm|giúp|hộ|cho)?\s*(?:mình|tôi|tớ|em|me)?\s*(?:là|rằng|that)?\s*[:,]?/iu;

/** LOOSE forget detection — EXTRACTOR-only safety net behind parseForgetCommand. Any forget-ish
 *  verb ("đừng/chớ quên" excluded — that's a remember) paired with a memory-field word means the
 *  sentence is ABOUT erasing memory: never capture a field out of it, even when the strict parse
 *  declined to execute it. See the probe-pinned tests ("TANGLED forget"). */
const LOOSE_FORGET_VERB_RE =
  /(?:(?<!đừng\s)(?<!chớ\s)(?:quên|xóa|xoá|bỏ|forget|clear)|đừng\s+nhớ)(?![\p{L}])/iu;
const MEMORY_FIELD_RE =
  /(?:mục\s*tiêu|vị\s*trí|role|định\s*hướng|target|deadline|thời\s*hạn|hạn\s*(?:nộp|chót)|thời\s*gian)/iu;

/** "quên deadline đi" → which fields to drop; null = not a clean forget command (falls to LLM).
 *  Shared by routeIntent AND the extractor's nullifier so the router can never disagree with
 *  what actually gets forgotten. */
function parseForgetCommand(text: string): { role: boolean; deadline: boolean } | null {
  const t = text.trim();
  if (t.length > 80) return null;
  if (!/^\s*(?:bạn\s+|cậu\s+)?(?:quên|xóa|xoá|bỏ|đừng\s+nhớ|forget|clear)\b/iu.test(t)) return null;
  // 'vị trí'/'role' are FIELD words here but domain words in DOMAIN_HINT — judge the payload
  // guard on the sentence with them removed, so "quên deadline đi, còn CV thì sửa sao?" still
  // falls to the LLM while "quên vị trí đi" stays a clean command.
  if (DOMAIN_HINT.test(t.replace(/vị\s*trí|role/giu, ' '))) return null;
  const all = /(?:hết|tất\s*cả|mọi\s*thứ|những\s+gì|everything|all\b)/iu.test(t);
  const role = all || /(?:mục\s*tiêu|vị\s*trí|role|định\s*hướng|target)/iu.test(t);
  const deadline = all || /(?:deadline|thời\s*hạn|hạn\s*(?:nộp|chót)|thời\s*gian)/iu.test(t);
  return role || deadline ? { role, deadline } : null;
}

export function routeIntent(question: string, facts: DiagnosisFacts): DiagnosisIntent {
  const q = question.trim();
  if (GREETING_RE.test(q) && !DOMAIN_HINT.test(q)) return 'greeting';
  if (THANKS_RE.test(q) && !DOMAIN_HINT.test(q)) return 'thanks';
  // The DOMAIN_HINT guard matters here too: "bạn là ai mà chấm CV mình có 58 điểm vậy" is a real
  // question about THEIR score wearing a meta opener — canned meta copy would dodge it (measured).
  if (q.length <= 50 && META_RE.test(q) && !DOMAIN_HINT.test(q)) return 'meta';
  if (q.length <= 60 && WHAT_YOU_KNOW_RE.test(q)) return 'what_you_know';
  if (parseForgetCommand(q)) return 'forget';
  if (RECALL_RE.test(q)) return 'recall';
  if (COMPARE_JD_RE.test(q) && (facts.other_matches?.length ?? 0) > 0) return 'compare_jd';
  if (REMEMBER_RE.test(q) && (roleFrom(q) !== null || deadlineFrom(q) !== null)) return 'remember';
  return 'advice';
}

// ── canned replies (code-authored — zero fabrication surface, zero latency) ──────────────────────

// Exported for the fabrication-gate spec: canned copy is served WITHOUT the gate (code-authored,
// by design) and persisted into {{history}} like everything else — so the spec holds it to the
// same two invariants, or a future copy edit could quietly teach the model a banned register.
export const CANNED: Record<'greeting' | 'thanks' | 'meta', { vi: string; en: string }> = {
  greeting: {
    vi: 'Chào bạn! Mình đang cầm sẵn kết quả chẩn đoán CV của bạn đây. Bạn muốn biết nên sửa gì trước, hay đang thắc mắc chỗ nào trong kết quả?',
    en: "Hey! I've got your CV diagnosis right here. Want to know what to fix first, or is there a part of the result you're curious about?",
  },
  thanks: {
    vi: 'Rất vui được giúp! Khi nào sửa xong CV, bạn quét lại rồi mình xem tiếp cho nhé.',
    en: "Happy to help! Once you've made the edits, re-scan your CV and we'll take another look together.",
  },
  meta: {
    vi: 'Mình là trợ lý chẩn đoán CV của bạn. Mình chỉ nói dựa trên dữ liệu đã xác minh trong hồ sơ của bạn — điểm số, các mục còn yếu, các gap so với JD — và giúp bạn chọn việc đáng làm trước. Bạn muốn bắt đầu từ đâu?',
    en: "I'm your CV-diagnosis assistant. Everything I say comes from your own verified record — your scores, weak spots, and gaps against the JD — and I help you pick what's worth fixing first. Where do you want to start?",
  },
};

/** Wave 2 memory-verb echoes — COMPOSED from code-extracted state (vs the static CANNED trio).
 *  Templates are digit-free by construction; the only digits that can appear are state values the
 *  candidate said themselves (their licensed speech, replayed verbatim). No '?' anywhere: this
 *  copy replays into history as ASSISTANT text and must never register on ASKED_ROLE_RE /
 *  ASKED_DEADLINE_RE, or the ask-back directive dies for the rest of the thread. */
function composedCanned(
  intent: DiagnosisIntent,
  state: DiagnosisConversationState,
  question: string,
  lang: 'vi' | 'en',
  deadlineIsStale = false,
): string | null {
  const en = lang === 'en';
  if (intent === 'what_you_know') {
    const parts: string[] = [];
    if (state.target_role)
      parts.push(en ? `you're aiming for ${state.target_role}` : `bạn nhắm ${state.target_role}`);
    if (state.deadline)
      parts.push(
        deadlineIsStale
          ? en
            ? `you once said your time budget was ${state.deadline} — that was a while back, it may no longer hold`
            : `bạn từng nói quỹ thời gian là ${state.deadline} — cũng lâu rồi, chưa chắc còn đúng`
          : en
            ? `your time budget is ${state.deadline}`
            : `quỹ thời gian của bạn là ${state.deadline}`,
      );
    if (!parts.length)
      return en
        ? "Beyond your diagnosis I haven't noted anything about you yet — tell me your target role and timeline, and I'll keep both in mind."
        : 'Ngoài bản chẩn đoán thì mình chưa ghi nhớ gì thêm về bạn — bạn cứ nói mục tiêu và quỹ thời gian, mình sẽ nhớ.';
    return en
      ? `Here's what I'm holding onto: ${parts.join(', ')}. Tell me to forget any of it and it's gone.`
      : `Mình đang nhớ: ${parts.join(', ')}. Muốn mình bỏ điều nào thì bảo "quên ... đi" nhé.`;
  }
  if (intent === 'forget') {
    const target = parseForgetCommand(question);
    if (!target) return null;
    const names = [
      ...(target.role ? [en ? 'your target role' : 'mục tiêu của bạn'] : []),
      ...(target.deadline ? [en ? 'your deadline' : 'thời hạn của bạn'] : []),
    ];
    // Field NAME only, never the forgotten value — echoing the value back would both defeat
    // the point and re-teach digits into history.
    return en
      ? `Done — I've forgotten ${names.join(' and ')}. I won't lean on it from here on.`
      : `Đã quên ${names.join(' và ')} rồi nhé. Từ giờ mình sẽ không dựa vào đó nữa.`;
  }
  if (intent === 'remember') {
    const value = roleFrom(question) ?? deadlineFrom(question);
    if (!value) return null;
    return en
      ? `Noted: ${value}. I'll factor it into everything from here.`
      : `Nhớ rồi nhé: ${value}. Từ giờ mình sẽ tính theo hướng đó.`;
  }
  return null;
}

// ── the ask-back condition (needs_detail, done the code way) ─────────────────────────────────────

/** Questions where knowing the role/timeline would actually CHANGE the advice. A definitional
 *  question ("điểm ATS nghĩa là gì?") gets no ask — asking there is noise, not care. */
const ADVICE_SEEKING =
  /nên|làm\s+(?:gì|sao)|bắt\s+đầu|cải\s+thiện|sửa|ưu\s+tiên|học\s+(?:gì|cái\s+gì|thêm)|trước\s+tiên|tiếp\s+theo|lộ\s+trình|kế\s+hoạch|hướng\s+dẫn|giúp\s+(?:mình|em|tớ)\s+với|chỉ\s+(?:mình|em|tớ|giúp)|cái\s+nào|ví\s+dụ|what\s+should|how\s+(?:do|can)\s+i|improve|fix|prioritize|where\s+(?:do|should)\s+i\s+start|help\s+me|example/iu;

export function askDirective(
  state: DiagnosisConversationState,
  intent: DiagnosisIntent,
  question: string,
): 'role' | 'deadline' | null {
  if (intent !== 'advice' || !ADVICE_SEEKING.test(question)) return null;
  if (state.target_role === null && !state.asked_role) return 'role';
  if (state.deadline === null && !state.asked_deadline) return 'deadline';
  return null;
}

// ── advised-coverage tracking (anti prose-repetition) ────────────────────────────────────────────

/**
 * Gap display_names the ASSISTANT has already spoken in this conversation. Judged live runs
 * measured the remaining template-feel (6/25 turns) coming from the model re-reciting the same
 * priority list whenever the user circles back with "rồi sao nữa" — same FACTS in, same list out.
 * A prompt instruction alone cannot fix that (the model does not know which items are stale), so
 * CODE computes the coverage: the advisor names gaps verbatim from FACTS, which makes a
 * case-insensitive substring scan over the assistant turns exact. USER turns deliberately do not
 * count — the user typing "Machine Learning?" has not been ADVISED about it yet.
 */
export function coveredGapNames(facts: DiagnosisFacts, history: HistoryMessage[]): string[] {
  // Wave 3 (3B): advice given while the candidate targeted a DIFFERENT role is ARCHIVED — only
  // assistant turns after the LAST role change count as coverage. Otherwise the anti-repetition
  // directive keeps steering AWAY from gaps that were advised for the old role and deserve a
  // fresh pass for the new one. Same fail-soft primitives as extraction (forget turns skipped,
  // tangled-forget turns skipped); a missed change keeps today's behavior, never breaks it.
  // `currentRole` tracks the last CAPTURED role even across a forget — so "quên vị trí đi" +
  // "mình nhắm Backend nhé" still reads as a CHANGE vs the pre-forget role, while forgetting
  // alone (or restating the same role) archives nothing.
  let currentRole: string | null = null;
  let boundary = -1;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'user') continue;
    if (parseForgetCommand(m.content)) continue;
    if (LOOSE_FORGET_VERB_RE.test(m.content) && MEMORY_FIELD_RE.test(m.content)) continue;
    const role = roleFrom(m.content);
    if (!role) continue;
    if (currentRole !== null && role.toLowerCase() !== currentRole.toLowerCase()) boundary = i;
    currentRole = role;
  }
  const advisorText = history
    .filter((m, i) => m.role === 'assistant' && i > boundary)
    .map((m) => m.content)
    .join('\n');
  if (!advisorText) return [];
  // WORD-boundary match, not bare substring: the taxonomy carries one-letter display names
  // ("R", "C") that includes() finds inside ordinary prose — every "c" in "trước" marked the C
  // gap as advised, so the directive steered the model AWAY from a gap it never opened
  // (probe-confirmed 2026-07-17). Same lookaround idiom as ROLE_WORD above.
  return facts.gap_items
    .map((g) => g.display_name)
    .filter((name) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
        'iu',
      ).test(advisorText),
    );
}

// ── per-intent FACTS selection (Wave 3 — the Sierra typed-blocks lesson) ────────────────────────

/**
 * Choose the FACT groups a turn actually needs. v0 cut: `other_matches` matter ONLY on a
 * comparison turn — everywhere else they are prompt noise AND an over-wide licensing surface
 * (their scores stayed speakable on turns whose context never showed them).
 * The caller MUST feed the SAME trimmed object to the prompt render and to groundDiagnosis, so
 * the licensing set is exactly as wide as the context the model actually saw — fail-closed.
 */
export function factsForIntent(facts: DiagnosisFacts, intent: DiagnosisIntent): DiagnosisFacts {
  if (intent === 'compare_jd' || !facts.other_matches?.length) return facts;
  const trimmed = { ...facts };
  delete trimmed.other_matches;
  return trimmed;
}

// ── the shared entry point ───────────────────────────────────────────────────────────────────────

/**
 * Everything the service (and the calibration harnesses — REAL code, never a mirror) needs to run
 * one intelligent turn: the state, the route, the canned short-circuit, and the context block that
 * goes into the prompt's context injection point.
 */
export function buildTurnContext(
  facts: DiagnosisFacts,
  history: HistoryMessage[],
  question: string,
  language?: string,
  now: Date = new Date(),
): DiagnosisTurnContext {
  const state = extractConversationState(history, question);
  const intent = routeIntent(question, facts);
  const lang: 'vi' | 'en' = language?.toLowerCase().startsWith('en') ? 'en' : 'vi';
  const stale = deadlineStale(state, now);

  const canned =
    intent === 'greeting' || intent === 'thanks' || intent === 'meta'
      ? CANNED[intent][lang]
      : composedCanned(intent, state, question, lang, stale);

  const lines: string[] = [
    'Known about the candidate (extracted by code from this conversation — trust it, do not re-ask):',
    `- Target role: ${state.target_role ?? '(not stated yet)'}`,
    // A relative deadline decays with the wall clock — once its own span has elapsed since the
    // row that stated it, serving it as current would be a truthful-yesterday lie today.
    stale
      ? `- Time budget/deadline: "${state.deadline}" — stated a while ago and may ALREADY be past; do NOT treat it as current.`
      : `- Time budget/deadline: ${state.deadline ?? '(not stated yet)'}`,
  ];

  // Coverage lines appear only once something HAS been advised — on turn one they would just
  // duplicate the FACTS gap list as noise.
  const covered = coveredGapNames(facts, history);
  const fresh = facts.gap_items
    .map((g) => g.display_name)
    .filter((name) => !covered.includes(name));
  if (covered.length) {
    lines.push(
      `- Already advised on (by you, earlier in this conversation): ${covered.join(', ')}`,
      `- Not yet mentioned from FACTS: ${fresh.length ? fresh.join(', ') : '(nothing left — everything has been named)'}`,
    );
  }

  const directives: string[] = [];
  if (covered.length) {
    directives.push(
      fresh.length
        ? 'Do NOT restate the priority list or advice you already gave in the Recent conversation. If they ask what to do (again), either go ONE level deeper and more concrete on an "Already advised" item, or open ONE item from "Not yet mentioned" — every turn must add something new.'
        : 'Do NOT restate the priority list or advice you already gave in the Recent conversation. Every FACTS item has been named — go ONE level deeper and more concrete on the most important one instead of repeating the list.',
    );
  }
  if (intent === 'recall') {
    directives.push(
      'They are asking about something already said in the Recent conversation. Answer it plainly from the conversation text (and the Known lines above); no citation needed.',
    );
  }
  if (intent === 'compare_jd') {
    directives.push(
      'They are asking to compare their JD/match options. Conclude with ONE choice from other_matches and set cited_other_match_index to it.',
    );
  }
  if (stale) {
    directives.push(
      'Their stated deadline is old and its window has likely closed. Do NOT plan around it as if current — acknowledge time may have moved on, and gently ask ONCE for their updated timeline.',
    );
  }
  const ask = askDirective(state, intent, question);
  if (ask === 'role') {
    directives.push(
      'They have NOT told you which role they are targeting, and it would change this advice. After answering from FACTS, end your message with ONE short question asking which role they are aiming for — nothing else appended.',
    );
  } else if (ask === 'deadline') {
    directives.push(
      'They have NOT told you how much time they have, and it would change this advice. After answering from FACTS, end your message with ONE short question asking about their timeline — nothing else appended.',
    );
  }
  // A stale deadline is no longer "usable" state: it must not be woven into advice as current,
  // and the demonstrate-memory opener must not proudly repeat it.
  const usableDeadline = stale ? null : state.deadline;
  if (state.target_role || usableDeadline) {
    directives.push(
      usableDeadline
        ? 'Weave the Known lines into the advice where they matter (their role shapes WHICH gap first; their deadline shapes HOW MUCH to attempt). Never ask for what is already Known.'
        : 'Weave their target role into the advice where it matters (it shapes WHICH gap first). Never re-ask for the role.',
    );
    // Wave 1 (the Duolingo List-of-Facts lesson): remembered state the user never SEES being
    // remembered buys no trust. On advice turns, order the model to SHOW the memory — the facts
    // are code-extracted, so speaking them back carries zero fabrication risk.
    if (intent === 'advice') {
      directives.push(
        usableDeadline
          ? 'When the advice depends on it, OPEN by naturally weaving in what they told you (their goal/deadline) in one clause — demonstrate the memory, never re-ask for it.'
          : 'When the advice depends on it, OPEN by naturally weaving in their goal in one clause — demonstrate the memory, never re-ask for it.',
      );
    }
  }
  if (directives.length) lines.push('Directive:', ...directives.map((d) => `- ${d}`));

  return { state, intent, canned, contextBlock: lines.join('\n'), ask };
}

// ── the ask-back BACKSTOP (code appends what the model was told to ask and didn't) ──────────────

/** No digits, and phrased so ASKED_ROLE_RE/ASKED_DEADLINE_RE recognize it in history — the
 *  backstop must register as "already asked" next turn, or it would nag forever. */
const ASK_FALLBACK: Record<'role' | 'deadline', [string, string]> = {
  // [vi, en]
  role: [
    'Mà bạn đang nhắm vị trí nào vậy? Biết rồi mình sẽ chỉ đúng chỗ đáng sửa hơn.',
    'By the way, which role are you aiming for? Knowing it helps me point you at the right fixes.',
  ],
  deadline: [
    'Mà bạn còn bao nhiêu thời gian trước hạn nộp vậy? Mình sẽ liệu cơm gắp mắm theo đó.',
    'By the way, how much time do you have before the deadline? I can size the plan to it.',
  ],
};

/**
 * Measured (live 25-turn, 07-16): the ask Directive alone was obeyed in 1 of 4 turns it fired —
 * the model answers well and then simply drops the closing question (or flattens it into an
 * offer). The WHEN is code's decision, so the DO becomes code's too: if the served answer carries
 * no question at all, append the standard one. This is the needs_detail principle finished — the
 * LLM phrases nicer asks when it complies, and this backstop guarantees the turn asks either way.
 * Only for turns the directive fired on; never stacks a second question onto an existing one.
 */
export function ensureAskBack(
  answer: string,
  ask: 'role' | 'deadline' | null,
  language?: string,
): string {
  if (!ask || answer.includes('?')) return answer;
  const lang = language?.toLowerCase().startsWith('en') ? 1 : 0;
  return `${answer.trim()} ${ASK_FALLBACK[ask][lang]}`;
}
