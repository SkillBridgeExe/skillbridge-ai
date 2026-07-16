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
  /** The advisor already asked for the role — asking twice is nagging, not caring. */
  asked_role: boolean;
  /** The advisor already asked about their timeline. */
  asked_deadline: boolean;
}

export type DiagnosisIntent = 'greeting' | 'thanks' | 'meta' | 'recall' | 'compare_jd' | 'advice';

export interface DiagnosisTurnContext {
  state: DiagnosisConversationState;
  intent: DiagnosisIntent;
  /** Non-null → serve this verbatim and skip the LLM entirely (greeting/thanks/meta). */
  canned: string | null;
  /** Rendered into the prompt's context injection point; never empty (stable placeholder). */
  contextBlock: string;
}

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
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
  /\s+(?:và|với|trong|trước|sau|nhé|nha|nghen|thì|mà|luôn|rồi|nữa|thôi|đã|không|ko|hả|à|ạ|á|vì|nên|hay|hoặc|and|with|in|before|but|or|so)(?![\p{L}\p{N}])[\s\S]*$/iu;

/** A capture that contains any of these is a question/junk, not a title. */
const ROLE_REJECT =
  /\b(?:nào|gì|đâu|sao|which|what|where|cv|hồ sơ|resume|bài tập|xong|này|đó|đấy|kia|tuyển dụng|khác)\b/iu;

/** Lowercase titles still accepted when they contain a recognizable role word ("backend dev"). */
const ROLE_WORD =
  /engineer|developer|dev|analyst|designer|tester|qa|qc|data|ai|ml|backend|back-end|frontend|front-end|fullstack|full-stack|devops|mobile|web|game|product|project|business|marketing|sales|scientist|architect|intern|fresher|junior|senior|manager|lead|pm|ba|hr|kế toán|nhân sự|lập trình|kiểm thử|phân tích|thiết kế|tuyển dụng viên/iu;

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

/** Did an assistant turn already ask this? Detected on the SERVED text (what history replays). */
const ASKED_ROLE_RE =
  /(?:vị\s*trí|role|position)[^.!?\n]{0,40}\?|(?:nhắm|ứng\s*tuyển|target)[^.!?\n]{0,40}\?/iu;
const ASKED_DEADLINE_RE =
  /(?:bao\s+lâu|bao\s+nhiêu\s+(?:tuần|ngày|thời\s+gian)|khi\s+nào\s+nộp|deadline|còn\s+(?:bao\s+nhiêu|nhiều)\s+thời\s+gian|how\s+(?:long|much\s+time))[^.!?\n]{0,40}\?/iu;

/**
 * Read the structured state out of the conversation. `history` should be the WIDEST window the
 * caller has (the platform passes more rows than the prompt shows); `question` is this turn's
 * message, which may itself state the role/deadline. Later statements win over earlier ones.
 */
export function extractConversationState(
  history: HistoryMessage[],
  question: string,
): DiagnosisConversationState {
  const state: DiagnosisConversationState = {
    target_role: null,
    deadline: null,
    asked_role: false,
    asked_deadline: false,
  };
  const userTexts = [...history.filter((m) => m.role === 'user').map((m) => m.content), question];
  for (const text of userTexts) {
    for (const re of ROLE_PATTERNS) {
      const m = text.match(re);
      const role = m ? cleanRole(m[1]) : null;
      if (role) state.target_role = role;
    }
    for (const re of DEADLINE_PATTERNS) {
      const m = text.match(re);
      if (m) state.deadline = m[1].trim().replace(/\s+/g, ' ');
    }
  }
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    if (ASKED_ROLE_RE.test(m.content)) state.asked_role = true;
    if (ASKED_DEADLINE_RE.test(m.content)) state.asked_deadline = true;
  }
  return state;
}

// ── intent router ────────────────────────────────────────────────────────────────────────────────

/** Any of these means the message carries real CV payload — never canned. */
const DOMAIN_HINT =
  /cv|điểm|score|ats|gap|kỹ\s*năng|skill|jd|match|bullet|kinh\s*nghiệm|dự\s*án|sửa|học|interview|phỏng\s*vấn|resume|hồ\s*sơ|chẩn\s*đoán|đậu|lương|salary|tuyển|apply|role|vị\s*trí/iu;

/** The ENTIRE message must be the greeting — "chào, CV mình sao rồi" falls through to the LLM. */
const GREETING_RE =
  /^\s*(?:hi+|hello+|hey+|yo|alo+|helo+|hé\s*lô|lô|chào(?:\s+(?:bạn|bot|em|anh|chị|buổi\s+(?:sáng|chiều|tối)))?|xin\s+chào|good\s+(?:morning|afternoon|evening))\s*[!.~^\-_*]*\s*$/iu;

const THANKS_RE =
  /^\s*(?:cảm\s*ơn|cám\s*ơn|thank(?:s|\s+you)?|tks|thx|bye+|byebye|tạm\s+biệt)(?:\s+(?:bạn|bot|nhiều|nha|nhé|nghen|so\s+much|a\s+lot))*\s*[!.~]*\s*$/iu;

const META_RE =
  /(?:bạn|mày|you)\s*(?:là\s*(?:ai|gì|bot)|làm\s+được\s+(?:những\s+)?gì|giúp\s+được\s+gì|biết\s+làm\s+gì|có\s+thể\s+làm\s+(?:được\s+)?gì)|who\s+are\s+you|what\s+can\s+you\s+do|are\s+you\s+a\s+bot/iu;

const RECALL_RE =
  /(?:vừa|lúc|hồi|ban)\s+nãy[^\n]{0,40}(?:nói|bảo|khuyên|hỏi)|bạn\s+(?:có\s+)?nhớ|mình\s+(?:đã\s+|vừa\s+)?nói\s+(?:gì|là\s+gì|vị\s*trí)|nhắc\s+lại\s+(?:giúp|cho|dùm)|(?:nói|bảo)\s+gì\s+ấy\s+nhỉ|what\s+did\s+(?:you|i)\s+(?:just\s+)?say|do\s+you\s+remember|remind\s+me\s+what/iu;

const COMPARE_JD_RE =
  /so\s+sánh[^\n]{0,40}(?:jd|match|vị\s*trí|job)|(?:jd|match|job)[^\n]{0,30}(?:nào|which)|(?:hợp|phù\s+hợp)[^\n]{0,20}(?:jd|vị\s*trí|job)\s+nào|which\s+(?:jd|job|match)/iu;

export function routeIntent(question: string, facts: DiagnosisFacts): DiagnosisIntent {
  const q = question.trim();
  if (GREETING_RE.test(q) && !DOMAIN_HINT.test(q)) return 'greeting';
  if (THANKS_RE.test(q) && !DOMAIN_HINT.test(q)) return 'thanks';
  if (q.length <= 50 && META_RE.test(q)) return 'meta';
  if (RECALL_RE.test(q)) return 'recall';
  if (COMPARE_JD_RE.test(q) && (facts.other_matches?.length ?? 0) > 0) return 'compare_jd';
  return 'advice';
}

// ── canned replies (code-authored — zero fabrication surface, zero latency) ──────────────────────

const CANNED: Record<'greeting' | 'thanks' | 'meta', { vi: string; en: string }> = {
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

// ── the ask-back condition (needs_detail, done the code way) ─────────────────────────────────────

/** Questions where knowing the role/timeline would actually CHANGE the advice. A definitional
 *  question ("điểm ATS nghĩa là gì?") gets no ask — asking there is noise, not care. */
const ADVICE_SEEKING =
  /nên|làm\s+gì|bắt\s+đầu|cải\s+thiện|sửa|ưu\s+tiên|học\s+(?:gì|cái\s+gì|thêm)|trước\s+tiên|tiếp\s+theo|lộ\s+trình|kế\s+hoạch|what\s+should|how\s+(?:do|can)\s+i|improve|fix|prioritize|where\s+(?:do|should)\s+i\s+start/iu;

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
): DiagnosisTurnContext {
  const state = extractConversationState(history, question);
  const intent = routeIntent(question, facts);
  const lang: 'vi' | 'en' = language?.toLowerCase().startsWith('en') ? 'en' : 'vi';

  const canned =
    intent === 'greeting' || intent === 'thanks' || intent === 'meta' ? CANNED[intent][lang] : null;

  const lines: string[] = [
    'Known about the candidate (extracted by code from this conversation — trust it, do not re-ask):',
    `- Target role: ${state.target_role ?? '(not stated yet)'}`,
    `- Time budget/deadline: ${state.deadline ?? '(not stated yet)'}`,
  ];

  const directives: string[] = [];
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
  if (state.target_role || state.deadline) {
    directives.push(
      'Weave the Known lines into the advice where they matter (their role shapes WHICH gap first; their deadline shapes HOW MUCH to attempt). Never ask for what is already Known.',
    );
  }
  if (directives.length) lines.push('Directive:', ...directives.map((d) => `- ${d}`));

  return { state, intent, canned, contextBlock: lines.join('\n') };
}
