import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { SkillBridgeGapReport } from '../gap-report/gap-report.service';
import { ProgressReport } from '../gap-report/gap-progress';
import { Fixability } from '../gap-engine/gap-item';

/**
 * Anti-fabrication core of the CV-diagnosis advisor (PURE — no LLM, no IO). The LLM only PHRASES an
 * answer over the user's OWN stored record; these functions own grounding:
 *  - buildDiagnosisFacts: the deterministic ALLOW-LIST distilled from the user's persisted CV review
 *    (overall/ats/4 dimensions/top actions) + gap report (top-N gaps). Every NUMBER the advisor may
 *    speak originates here — read verbatim from the record, never recomputed.
 *  - groundDiagnosis: the boundary. The model output is treated as PROSE ONLY — a cited_dimension is
 *    kept only if it is one of the 4 real dimension keys; a cited_gap_id is kept only if it is a real
 *    requirement_id in FACTS; raw URLs are stripped from the message + suggested_next_step; an empty /
 *    parse-failed answer degrades to a deterministic grounded fallback built from the user's own
 *    prioritized actions (never a 500). A fabricated dimension / gap / link can never reach the user.
 *
 * Mirrors learning-chat/chat-grounding.ts (drop-out-of-set + strip-URL + deterministic fallback) and
 * trends-insight.logic.ts groundInsight (numbers from FACTS, LLM text kept but clamped).
 */

/** The four canonical CV-review dimension keys (CvReviewLlmDimensions). The ONLY values a cited_dimension
 *  may take — anything else the model emits is dropped as fabricated. */
export const DIAGNOSIS_DIMENSION_KEYS = [
  'action_verbs',
  'skills_relevance',
  'experience',
  'education',
] as const;
export type DiagnosisDimensionKey = (typeof DIAGNOSIS_DIMENSION_KEYS)[number];

export interface DiagnosisDimensionFact {
  key: DiagnosisDimensionKey;
  /** 0-20 from the stored review (CvReviewLlmDimensions). */
  score20: number;
  rationale: string;
}

/** One gap surfaced to the advisor — the PII-free, deterministic subset of GapItem. */
export interface DiagnosisGapFact {
  requirement_id: string;
  display_name: string;
  cv_status: string;
  severity: number;
  /** pct_of_postings (0-100) or null. */
  market_demand: number | null;
  recommended_next_action: string;
  /** How this gap can be closed (learn/rewrite/add_evidence/not_fixable_now) — deterministic, from GapItem. */
  fixability: Fixability;
}

export interface DiagnosisOtherMatchInput {
  jd_title: string | null;
  overall_score: number | null;
  top_gaps: string[];
}

export interface DiagnosisOtherMatchFact {
  jd_title: string | null;
  overall_score: number | null;
  top_gaps: string[];
}

export interface DiagnosisFacts {
  /** Composite 0-100 CV score from the stored review; null when the record lacks it. */
  overall_score: number | null;
  /** Deterministic ATS rule score (0-100) from the stored review; null when absent. */
  ats_score: number | null;
  dimensions: DiagnosisDimensionFact[];
  top_summary: { prioritized_actions: string[] };
  /** Top-N gaps by severity (already severity-ranked by buildGapItems); [] on the CV-only path. */
  gap_items: DiagnosisGapFact[];
  /** Progress since the prior scan of the SAME CV+JD — present ONLY when there is a real, non-baseline
   *  ProgressReport (absent on first scan / CV-only path / a failed progress lookup) so the LLM prompt
   *  and any UI reading this shape see no key at all rather than an empty/undefined one. */
  progress?: {
    closed: string[];
    improved: string[];
    new_gaps: string[];
    /** Gaps whose status regressed since the prior scan. Deliberately NOT rendered on the banner
     *  (extraction noise can produce false "regressions" — a proactive alarm would demotivate),
     *  but the advisor must answer honestly when the user ASKS what got worse. */
    worsened: string[];
    /** curr_score - prev_score rounded; null when either score is unknown (never a fabricated delta). */
    score_delta: number | null;
  };
  /** V2 (Wave VALUE_CHAIN): canonicals of STILL-OPEN gaps whose learning content the user fully
   *  completed — PENDING VERIFICATION only (mascot: "đã học xong X — sẽ kiểm chứng ở lần quét tới").
   *  The honest framing travels in the key name (prompts untouched); never treated as CV evidence.
   *  Top-level (not under progress) because BASELINE first-scan reports carry it too — the
   *  learn-then-rescan window is exactly when this line matters. Absent when nothing is completed. */
  learning_completed_pending_verification?: string[];
  /** Other recent JD matches for THIS user, present only when available. Used only for explicit
   *  cross-JD comparison questions; excludes timestamps to avoid irrelevant prompt noise. */
  other_matches?: DiagnosisOtherMatchFact[];
  /** Sanitized tool-call results for THIS turn, keyed by tool name (e.g. 'github.enrich') — set by
   *  the chat-tool loop (#22 PR3), never by the model. Each value is {untrusted_data: ...}. */
  tool_results?: Record<string, unknown>;
}

export interface DiagnosisChatResult {
  answer: string;
  cited_dimension?: DiagnosisDimensionKey;
  cited_gap_id?: string;
  /** Validated 1-based index into facts.other_matches (mirrors the LLM's cited_other_match_index) —
   *  present ONLY when it resolved to a real entry; an out-of-range/absent index is undefined. The
   *  platform layer maps this back to the real match_id/cv_id for the wire's cited_match. */
  cited_other_match_index?: number;
  /** Validated tool name (e.g. 'github.enrich') — present ONLY when it matched a real facts.tool_results
   *  key. Forwarded verbatim to the wire so the FE can render its tool-citation chip. */
  cited_tool?: string;
  suggested_next_step?: string | null;
  trace?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    latencyMs: number;
    modelCode: string;
    estimatedCostUsd?: number;
  };
}

const MAX_GAP_ITEMS = 8;
const MAX_MESSAGE_LEN = 1500;

/** Markdown link [text](url) → keep only the text so stripping the url leaves no dangling bracket. */
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
/**
 * Any link-shaped token the advisor must never surface as a raw destination. The PRIMARY control is
 * the prompt forbidding URLs; this is the deterministic backstop (cloned from chat-grounding). Covers
 * any scheme://, www., and a host.tld/PATH (the path is the strong signal — avoids false positives on
 * bare tech terms like "Node.js" / "socket.io" that have no path).
 */
const URL_LIKE = new RegExp(
  [
    '\\b[a-z][a-z0-9+.\\-]*:\\/\\/\\S+',
    '\\bwww\\.\\S+',
    '\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}\\/\\S*',
  ].join('|'),
  'gi',
);

function stripRawUrls(text: string): string {
  return text
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL_LIKE, '[link]')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LEN);
}

function isEnglish(language?: string): boolean {
  return language?.toLowerCase().startsWith('en') === true;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ── Phase A: the warm refusal — what a blocked turn SAYS ─────────────────────────────────────────
/**
 * Served when a gate KILLED the model's prose (an unverifiable claim or an out-of-FACTS number).
 * Before this, 5 of 7 blocked turns in a 25-turn adversarial run were answered with a fact template
 * ("Mục đã xác minh: action_verbs đang ở 9/20…") — correct, and exactly the robot the candidate
 * meets at the moment they most need to feel heard: right after asking the tempting question. The
 * refusal is CODE-AUTHORED copy (it never faces the gates), so unlike the model it can safely NAME
 * the family of thing it will not guess:
 *   1. one warm sentence saying what it won't do and why — with NO digits and NO valuation tails,
 *      because this text is persisted and replayed into the next prompt's history, and the copy
 *      must not hand the model a phrase that trips the same gate it explains;
 *   2. one verified hook (cited gap > cited dimension > tool result > top prioritized action) so
 *      the turn still moves them forward instead of ending at "no";
 *   3. the citation is kept — the FE still scrolls to the card the hook talks about.
 */
const REFUSAL_FAMILY: Record<string, 'peers' | 'odds' | 'salary' | 'stat'> = {
  peer_comparison: 'peers',
  ranking: 'peers',
  grade_label: 'peers',
  hire_odds: 'odds',
  salary: 'salary',
  peer_stat: 'stat',
};

// Copy is written to be REPLAY-SAFE: it is persisted and echoed into the next prompt's history, so
// it must not contain the phrases the gates hunt ("tỉ lệ đậu", "ứng viên khác", comparatives) — the
// model imitates its conversation partner, and the refusal must never teach it the banned register.
const REFUSAL_COPY: Record<'peers' | 'odds' | 'salary' | 'stat' | 'numbers', [string, string]> = {
  // [vi, en]
  peers: [
    'So sánh kiểu đó thì mình không làm được thật — mình chỉ có dữ liệu chẩn đoán của riêng bạn, không có của ai để đặt cạnh, nên nói ra là đoán bừa.',
    "I honestly can't make that comparison — I only have your own diagnosis data, no one else's to put beside it, so anything I said there would be a guess.",
  ],
  odds: [
    'Đậu hay không thì mình không đoán đâu — dữ liệu của bạn không tính ra được điều đó, và một con số bịa thì hại hơn là giúp.',
    "Whether you'll get the offer isn't something I'll guess — your data can't produce that, and a made-up number would hurt more than help.",
  ],
  salary: [
    'Chuyện lương mình không có dữ liệu để nói, nên mình không đoán.',
    "I don't have any salary data, so I'm not going to guess about pay.",
  ],
  stat: [
    'Con số kiểu đó mình không có nguồn đã xác minh, nên mình không nói liều.',
    "I don't have a verified source for that kind of number, so I won't state it.",
  ],
  numbers: [
    'Chỗ này mình chỉ dám nói những gì dữ liệu đã xác minh của bạn thật sự có.',
    "Here I'll only say what your verified data actually contains.",
  ],
};

/** cv_status enum → human Vietnamese; unknown values pass through raw (never invented). */
const CV_STATUS_VI: Record<string, string> = {
  missing: 'chưa có trong CV',
  partial: 'mới có một phần',
  weak: 'còn mờ nhạt',
  present: 'đã có',
};

function buildRefusal(
  reason: string,
  resolved: {
    dimension?: DiagnosisDimensionFact;
    gap?: DiagnosisGapFact;
    otherMatch?: { fact: DiagnosisOtherMatchFact; index1: number };
    toolResult?: { toolName: string; data: unknown };
  },
  facts: DiagnosisFacts,
  language?: string,
): DiagnosisChatResult {
  const isEn = isEnglish(language);
  const family = REFUSAL_FAMILY[reason] ?? 'numbers';
  const parts: string[] = [REFUSAL_COPY[family][isEn ? 1 : 0]];

  const { dimension, gap, otherMatch, toolResult } = resolved;
  if (gap) {
    parts.push(
      isEn
        ? `What I can say for sure: ${gap.display_name} is ${gap.cv_status} in your CV — the step worth taking: ${gap.recommended_next_action}.`
        : `Điều mình nói chắc được: ${gap.display_name} đang ${CV_STATUS_VI[gap.cv_status] ?? gap.cv_status} — bước đáng làm nhất: ${gap.recommended_next_action}.`,
    );
  } else if (dimension) {
    parts.push(
      isEn
        ? `What I can say for sure: your ${dimension.key} sits at ${dimension.score20}/20. ${dimension.rationale}`.trim()
        : `Điều mình nói chắc được: mục ${dimension.key} của bạn đang ${dimension.score20}/20. ${dimension.rationale}`.trim(),
    );
  } else if (otherMatch) {
    // A comparison turn died on a fabricated garnish (a salary, an invented number). The stored
    // comparison itself is verified — keep it, so the user still gets the answer they asked for.
    const m = otherMatch.fact;
    const title = m.jd_title ?? (isEn ? 'an unnamed recent JD' : 'một JD gần đây chưa có tên');
    const score =
      m.overall_score === null
        ? isEn
          ? 'no stored score'
          : 'chưa có điểm đã lưu'
        : `${m.overall_score}/100`;
    const gaps = m.top_gaps.length
      ? m.top_gaps.join(', ')
      : isEn
        ? 'no stored top gaps'
        : 'không có gap chính đã lưu';
    parts.push(
      isEn
        ? `What I can compare from your stored data: the ${title} match sits at ${score}; its stored top gaps: ${gaps}.`
        : `Điều mình so sánh được từ dữ liệu đã lưu của bạn: JD ${title} đang ở ${score}, gap chính đã lưu: ${gaps}.`,
    );
  } else if (toolResult && toolResult.toolName === 'github.enrich') {
    const wrapped = toolResult.data as { untrusted_data?: Record<string, unknown> };
    const d = wrapped.untrusted_data ?? {};
    const exists = Boolean(d.exists);
    const repoCount = Array.isArray(d.public_repos) ? d.public_repos.length : 0;
    parts.push(
      !exists
        ? isEn
          ? 'What I did verify: no public GitHub account was found for that username.'
          : 'Điều mình đã kiểm tra được: không tìm thấy tài khoản GitHub công khai với username đó.'
        : isEn
          ? `What I did verify: your GitHub has ${repoCount} public repo(s).`
          : `Điều mình đã kiểm tra được: GitHub của bạn có ${repoCount} repo công khai.`,
    );
  } else if (facts.top_summary.prioritized_actions[0]) {
    parts.push(
      isEn
        ? `What's definitely worth doing right now: ${facts.top_summary.prioritized_actions[0]}`
        : `Thứ chắc chắn đáng làm ngay: ${facts.top_summary.prioritized_actions[0]}`,
    );
  }

  return {
    answer: stripRawUrls(parts.join(' ')),
    ...(dimension ? { cited_dimension: dimension.key } : {}),
    ...(gap ? { cited_gap_id: gap.requirement_id } : {}),
    ...(otherMatch ? { cited_other_match_index: otherMatch.index1 } : {}),
    ...(toolResult ? { cited_tool: toolResult.toolName } : {}),
    suggested_next_step:
      gap?.recommended_next_action ?? facts.top_summary.prioritized_actions[0] ?? null,
  };
}

/**
 * Distill the user's stored CV review + (optional) gap report into the deterministic FACTS allow-list.
 * Numbers are read VERBATIM from the record — nothing is recomputed. The CV-only path (no gap report)
 * yields gap_items: []. Honest-by-default: any missing field degrades to null / [] (never NaN / throw),
 * because older cached reviews may predate a field.
 */
export function buildDiagnosisFacts(
  review: CvReviewParsedResponse | null | undefined,
  gapReport: Pick<SkillBridgeGapReport, 'gap_items'> | null | undefined,
  progress?: ProgressReport | null,
  otherMatches?: DiagnosisOtherMatchInput[] | null,
): DiagnosisFacts {
  const dims = review?.llm_score_dimensions;
  const rationale = review?.rationale;
  const dimensions: DiagnosisDimensionFact[] = dims
    ? DIAGNOSIS_DIMENSION_KEYS.filter((key) => typeof dims[key] === 'number').map((key) => ({
        key,
        score20: dims[key],
        rationale: stringOrEmpty(rationale?.[key]),
      }))
    : [];

  const prioritized = review?.top_summary?.prioritized_actions;
  const prioritized_actions = Array.isArray(prioritized)
    ? prioritized.filter((a): a is string => typeof a === 'string')
    : [];

  const gap_items: DiagnosisGapFact[] = (gapReport?.gap_items ?? [])
    .slice(0, MAX_GAP_ITEMS)
    .map((g) => ({
      requirement_id: g.requirement_id,
      display_name: g.display_name,
      cv_status: g.cv_status,
      severity: g.severity,
      market_demand: g.market_demand ?? null,
      recommended_next_action: g.recommended_next_action,
      fixability: g.fixability,
    }));

  const facts: DiagnosisFacts = {
    overall_score: numOrNull(review?.overall_score),
    ats_score: numOrNull(review?.ats_rule_score),
    dimensions,
    top_summary: { prioritized_actions },
    gap_items,
  };

  if (progress && !progress.baseline) {
    facts.progress = {
      closed: progress.transitions
        .filter((t) => t.kind === 'closed')
        .map((t) => t.display_name)
        .slice(0, 8),
      improved: progress.transitions
        .filter((t) => t.kind === 'improved')
        .map((t) => t.display_name)
        .slice(0, 8),
      new_gaps: progress.transitions
        .filter((t) => t.kind === 'new')
        .map((t) => t.display_name)
        .slice(0, 8),
      worsened: progress.transitions
        .filter((t) => t.kind === 'worsened')
        .map((t) => t.display_name)
        .slice(0, 8),
      score_delta:
        progress.prev_score != null && progress.curr_score != null
          ? Math.round(progress.curr_score - progress.prev_score)
          : null,
    };
  }

  if (progress?.learning_completed?.length) {
    facts.learning_completed_pending_verification = progress.learning_completed.slice(
      0,
      MAX_GAP_ITEMS,
    );
  }

  if (otherMatches && otherMatches.length > 0) {
    facts.other_matches = otherMatches.slice(0, 3).map((match) => ({
      jd_title: match.jd_title,
      overall_score: match.overall_score,
      top_gaps: match.top_gaps.slice(0, 2),
    }));
  }

  return facts;
}

/** Deterministic grounded fallback built ONLY from the user's own FACTS — used on empty / failed model
 *  output, and on an LLM transport failure (the domain service calls this). Never throws, never empty.
 *  Localized: English framing when language === 'en', otherwise the Vietnamese default — so an English
 *  user does NOT get a Vietnamese answer on every Gemini timeout/429/empty-parse. The prioritized actions
 *  themselves are read VERBATIM from FACTS (in whatever language the CV review produced them). */
function fallback(facts: DiagnosisFacts, language?: string): DiagnosisChatResult {
  const actions = facts.top_summary.prioritized_actions.slice(0, 3);
  const isEn = isEnglish(language);
  let answer: string;
  if (actions.length) {
    const list = actions.map((a, i) => `(${i + 1}) ${a}`).join('; ');
    // Advisor v2 honesty: ADMIT the question wasn't answered instead of answering a different one
    // (the old copy read like a reply and users rightly called it a parrot). The verified
    // priorities still ride along so the turn is never useless.
    answer = isEn
      ? `I can't answer that confidently from your verified diagnosis data. Based on your CV diagnosis, the actions worth prioritizing: ${list}.`
      : `Mình chưa đủ dữ kiện đã xác minh để trả lời chắc câu này. Dựa trên chẩn đoán CV của bạn, những việc nên ưu tiên: ${list}.`;
  } else {
    answer = isEn
      ? "I don't have enough diagnosis data to answer specifically yet — please re-run your CV diagnosis and ask again."
      : 'Mình chưa có đủ dữ liệu chẩn đoán để trả lời cụ thể — bạn hãy chạy lại phần chẩn đoán CV rồi hỏi lại nhé.';
  }
  return { answer: stripRawUrls(answer) };
}

// ── Advisor v2 number gate — the deterministic wall between "the model phrased verified facts"
// and "the model invented a number". Everything the model may cite numerically must already
// exist in FACTS: numeric values, numbers inside verbatim fact strings, list sizes (so honest
// counting like "3 gap" stays legal), and the two score scales (/20, /100).
/**
 * Which small digits the advisor may speak used to be LUCK. Every digit had to sit in FACTS, and
 * FACTS seeds array LENGTHS — so "2" was legal for a user with 2 gaps and fabricated for a user with
 * 5, and "1" was legal for almost nobody. Measured live: "mình có thể giúp bạn chọn đúng 1 việc để
 * làm ngay hôm nay" — good prose, thrown away for the fact template over the token "1". The
 * randomness ran both ways: the gate waved through "bạn có 3 gap" for a user with 2 gaps, because
 * prioritized_actions happened to have length 3. Small numbers were never really guarded.
 *
 * A digit is exempt only in the two shapes that cannot carry a claim about the record:
 *  (a) an ordinal MARKER inside an ASCENDING RUN — "(1) …; (2) …" or a line-start "1." / "2)" —
 *      pure formatting, which the deterministic fallback below writes itself;
 *  (b) the quantity ONE over a listed advice noun — "chọn 1 việc", "mỗi bullet 1 động từ".
 * Everything else still faces the gate: a dangling value ("điểm tăng 7."), anything on a scale
 * ("12/20", "9%", "35 triệu"), and any count of anything ("7 dự án", "3 kỹ năng", "5 chỗ").
 *
 * Both shapes are narrower than they look, and the narrowing is load-bearing — the wider cut of each
 * was MEASURED shipping fabricated scores:
 *  (a) THE RUN. Reading "(N)" as a marker anywhere served "Mục skills_relevance của bạn (8) nên được
 *      cải thiện." and "Điểm ATS của bạn (7) là hơi thấp." verbatim (verified on a fixture holding
 *      neither 7 nor 8): the (91)/100 laundering again, one digit down — brackets back as a licence
 *      to invent. An enumeration starts at 1 and each step follows its predecessor; a score does not.
 *      So "(N)" needs "(N-1)" earlier in the same message. The residue is a fabricated "1", which is
 *      not a plausible score, salary or percentage.
 *  (b) ONE ONLY. Exempting 1-9 over an advice noun served "Bạn còn 5 việc phải sửa trong CV.",
 *      "CV của bạn có 6 bullet chưa có số liệu.", "Bạn thiếu 8 động từ mạnh." — fabricated COUNTS of
 *      the record, over the very nouns the list adds. "việc/chỗ/điều" are plain synonyms for a gap
 *      item, so the list was quietly re-opening "bạn có 5 gap". Only "1" was ever measured lost
 *      ("chọn đúng 1 việc"), only "1" is bought back, and "1 <noun>" cannot be a score/%/salary.
 *      Cost: "Có 2 hướng" / "3 bước" are back to luck when 2/3 are in no FACTS array's length.
 *
 * ADVICE_NOUN is an ALLOW-list on purpose. The deny-list shape ("every noun except the scales") fails
 * OPEN — the first noun nobody thought of ships "bạn cần 5 dự án nữa" as fact. Here an unlisted noun
 * just falls back to the gate, i.e. today's behaviour, so a forgotten word costs at most a templated
 * turn. Single digit only, tested on the SAME tokens the gate reads, so a score can never be
 * assembled out of exempt parts: "91" is one two-digit token, never two exempt digits.
 *
 * This REPLACES the old LIST_MARKER strip, which existed for case (a) alone and paid for it with the
 * laundering pattern that already cost us "(91)/100" once: it deleted markers before the check while
 * the ORIGINAL text shipped. Anchoring it to a clause boundary did NOT close that class — measured on
 * the shipped fix: "Tổng điểm CV của bạn: 91. Bạn nên…" (a colon IS a clause boundary, and \d{1,2}
 * eats "91") served a fabricated score verbatim, as did "Điểm ATS của bạn: 85." and the English form.
 * That is the most natural way a model states a score, so the hole was on the mainline, not an exotic
 * path. A rule that rewrites text to check it while shipping the original has no safe anchor — patch
 * one seam and the next phrasing walks through. Nothing is stripped now: the gate reads the exact
 * text that ships, so there is no second version to disagree with the one served.
 *
 * ponytail: an unbracketed mid-line list ("Ưu tiên: 1. Sửa bullet; 2. Học Docker") falls to the gate —
 * it is textually identical to "Điểm CV: 9. Rất thấp". Markdown/bracketed lists (what the model and
 * the fallback actually write) are unaffected. ponytail: "1-2 tuần" is still gated ("1" is followed by
 * "-2 tuần", not by a noun) and number-after-noun ordinals ("bước 3") never were exempt. Both need a
 * separate rule; add one only if a live run shows them costing real turns.
 */
// Time spans and deliverables joined after a live run measured them lost: "dành 1 tuần", "thêm 1 dự
// án", "thêm 1 ví dụ", "mỗi bullet có 1 động từ và 1 con số" are the action-advice register itself.
// Still "1"-only — "1 <any of these>" cannot be a score, a percentage or a salary; the worst case
// ("CV bạn chỉ có 1 dự án") mis-counts the record at exactly one, the same ceiling the original
// việc/bullet entries accepted.
const ADVICE_NOUN =
  /^\s*(?:việc|thứ|hướng|cách|bước|ý|chỗ|điều|động từ|bullet|dòng|câu|đoạn|tuần|ngày|tháng|buổi|giờ|dự án|ví dụ|con số|thing|step|way|option|line|sentence|verb|week|day|month|hour|project|example)(?![\p{L}\p{N}])/iu;

function isBenignQuantity(text: string, index: number, token: string): boolean {
  if (!/^[1-9]$/.test(token)) return false;
  const before = text.slice(0, index);
  const after = text.slice(index + 1);
  if (/[\d/]$/.test(before)) return false; // the other half of a scale — "12/20", "3/5"
  const n = Number(token);
  // (a) ordinal marker, and only inside an ascending run: "(1)" opens one, "(N)" needs "(N-1)"
  //     earlier. The trailing LETTER is load-bearing too: without it "(9)/100" reads as a marker.
  if (/\($/.test(before) && /^\)\s+\p{L}/u.test(after))
    return n === 1 || before.includes(`(${n - 1})`);
  if (/(?:^|\n)[ \t]*$/.test(before) && /^[.)]\s+\p{L}/u.test(after))
    return n === 1 || new RegExp(`(?:^|\\n)[ \\t]*${n - 1}[.)]\\s`).test(before);
  // (c) "số 1" — the noun-BEFORE-number idiom ("ưu tiên số 1", "việc số 1"). Measured: 2 of 25
  //     live turns lost to it. ONE only, same ceiling argument as (b); the after-guard keeps
  //     "điểm số 1/20" and "số 1%" facing the gate — those are a scale and a rate, not the idiom.
  if (n === 1 && /(?:^|[^\p{L}])số\s*$/iu.test(before) && !/^\s*[/\d%,.]/.test(after)) return true;
  // (b) the quantity ONE over an advice noun.
  return n === 1 && ADVICE_NOUN.test(after);
}

/**
 * Claims the advisor CANNOT know from FACTS, phrased without digits so the number gate is blind to
 * them. FACTS hold the candidate's own record only: no peer distribution, no percentile, no hire
 * odds, no salary. Observed live: "CV của bạn đang ở mức trung bình khá" and, under pressure for a
 * percentile, "nếu buộc phải nói theo cảm nhận … chưa ở nhóm nổi bật" — a vibes-based ranking from a
 * tool whose whole value is being grounded.
 *
 * Scope is the USER-vs-OTHERS axis only. Comparing two entries that BOTH live in FACTS (e.g. which
 * gap has the higher market_demand) stays legal — that is the model doing its job.
 *
 * The prompt is taught to refuse these WITHOUT restating the metric, so an honest refusal does not
 * trip its own gate.
 */
const UNVERIFIABLE_CLAIM: ReadonlyArray<readonly [string, RegExp]> = [
  // The quantifier arm covers the DIGIT-LESS retreat: told "never pin 71% to a group", the model
  // complies by dropping the number and keeping the claim — "Phần lớn nhà tuyển dụng yêu cầu kỹ năng
  // này" (measured shipping). So the market-side nouns join the peer-side ones here. This arm IS a
  // noun list and inherits its fail-open (an unlisted "HR" walks through) — accepted for this class
  // only, because a hedged claim with NO number is the softest of the family and the prompt now
  // forbids the whole subject; the numeric forms below are closed structurally, not by nouns.
  [
    'peer_comparison',
    /mặt bằng chung|(?:so với|hơn|kém|thua)\s+(?:những |các |đa số |phần lớn |hầu hết |nhiều )*(?:người|ứng viên|bạn)|(?:ứng viên|người|bạn)\s+khác|(?:đa số|phần lớn|hầu hết|nhiều|most|the majority of)\s+(?:các |những |ứng viên|nhà tuyển dụng|công ty|doanh nghiệp|tin tuyển dụng|candidates?|applicants?|employers?|recruiters?|companies)+(?!\p{L})|compared to (?:most |other |the average )?(?:candidates?|applicants?)|other candidates|(?:above|below)\s+average|average for (?:this|the) role/iu,
  ],
  [
    'ranking',
    /top\s*(?:\d|đầu|tier)|xếp hạng|percentile|thứ hạng|(?:nhóm|phân khúc)\s+(?:đầu|giữa|dưới|cuối|nổi bật|dẫn đầu)|(?:nổi bật|nổi trội)\s+hơn|standout group/iu,
  ],
  // \p{L} boundary is load-bearing: without it "mức khá" matched inside "mức KHÁC", so an ordinary
  // sentence ("các gap ở mức khác nhau") was discarded as a fabricated grade.
  [
    'grade_label',
    /trung bình khá(?!\p{L})|(?:mức|tầm|loại|hạng)(?:\s+độ)?\s+(?:trung bình|khá|giỏi|xuất sắc|kém)(?!\p{L})|fairly average|pretty average/iu,
  ],
  // The odds phrase is a claim only when it gets VALUED — "khả năng đậu của bạn là khá cao" grades
  // an unknowable; "sửa xong, cơ hội được gọi phỏng vấn sẽ tốt hơn" is the direction-of-improvement
  // closer every honest advisor uses (measured over-blocked: the encouragement register the prompt
  // itself asks for). So the VN arm requires a valuation tail (là/:/khoảng/cao/thấp/bao nhiêu/digit)
  // and the EN arm a graded adjective — improvement verbs stay free.
  [
    'hire_odds',
    /(?:khả năng|tỉ lệ|tỷ lệ|xác suất|cơ hội)[^.!?]{0,25}(?:đậu|trúng tuyển|pass|gọi (?:đi )?phỏng vấn|qua vòng|vào vòng)[^.!?]{0,15}?(?:là|:|khoảng|tầm|bao nhiêu|cao|thấp|\d|%)|chắc (?:đậu|trúng)|(?:chances?|odds) of (?:getting|being|landing)[^.!?]{0,30}?(?:high|low|good|great|slim|strong|\d|%)/iu,
  ],
  [
    'salary',
    /(?:mức lương|lương|thu nhập)[^.!?]{0,20}(?:khoảng|tầm|dự kiến|bao nhiêu|thường|tốt|cao|ổn)|mức lương|salary|pay range|compensation/iu,
  ],
  // Statistic SCAFFOLDS — sentence frames that exist only to state a rate, caught by their frame so
  // the noun inside them is irrelevant. "Cứ 100 tin tuyển dụng thì có 71 tin dùng ATS" carries the
  // real 71 with no "%" token at all; "Tỉ lệ nhà tuyển dụng yêu cầu Docker là 0,71" puts the
  // population BEFORE the number, out of reach of any after-the-number check. Both measured shipping,
  // both saved (when at all) only by which digits the fixture happened to contain.
  ['peer_stat', /cứ\s+\d+[^.!?\n]{0,40}?(?:thì\s+)?có\s+\d+/iu],
  // (?!\s*%|\d) — when the stated number IS a percentage, the licensing layer below owns the
  // verdict: "Tỉ lệ bullet có số liệu hiện là 9%" is a GROUNDED rate (FACTS write "9%") and must
  // live, while "Tỉ lệ nhà tuyển dụng yêu cầu Docker là 71%" still dies (71% unlicensed without the
  // field name, and the actor veto besides). Bare decimals ("là 0,71") have no licensed form → the
  // frame fires.
  [
    'peer_stat',
    /(?:tỉ|tỷ)\s*lệ[^.!?\n]{0,50}?(?:là|đạt|khoảng|chiếm|lên tới|:)\s*\d+(?:[.,]\d+)?(?!\s*%|\d)/iu,
  ],
];

// ── peer_stat, structural form. The number gate asks where a number CAME FROM, never what it is
// ASSERTED TO MEAN, so the one percentage in FACTS (market_demand, pct_of_POSTINGS for one skill) is
// also the one the model can lie with — the number is real, the subject and predicate are invented.
// Measured shipping: "71% nhà tuyển dụng yêu cầu kỹ năng này." · "Có tới 71% tin tuyển dụng dùng ATS
// để lọc."
//
// The first cut listed the populations to block. An adversarial pass killed it the way this file's
// own ADVICE_NOUN comment predicts a noun deny-list dies: Vietnamese has unbounded synonyms for the
// same crowd, and every probe survivor was one word off the list — "71% HR…", "71% JD…", "71% thị
// trường…", "71% headhunter…", "71% mô tả công việc…". All shipped verbatim.
//
// So no nouns. The rule is PROVENANCE OF THE PHRASE, the same principle the number gate applies to
// tokens: a percentage may be ATTACHED to a following word only if FACTS attach it to that word —
// "9% bullet" serves because the record itself says "hiện chỉ 9% bullet có số"; "71% <anything>"
// dies because the record never pins 71% to anything. The noun nobody thought of is now blocked by
// default instead of shipped by default: the unlisted word costs a templated turn, not a fabricated
// statistic. The lie's PREDICATE ("dùng ATS để lọc") never needs to be seen — the attachment itself
// is the violation. The fact survives in the detached wording that cannot host a subject or a
// predicate — "Nhu cầu thị trường: 71%" — which is renderGroundedAnswer's own template line and what
// the prompt teaches.
//
// The attach-to-the-next-word version of that rule ALSO fell to an adversarial pass, in both
// directions at once, because it still reads LOCAL syntax: put the crowd BEFORE the number and
// detach the % with punctuation ("Nhà tuyển dụng (71%) đều dùng ATS.") and there is no word-after-%
// to inspect; route through the safe-list ("Thực tế 71% là nhà tuyển dụng dùng ATS…", "71% cao hơn
// vì nhà tuyển dụng đòi hỏi…") and the gate's own glue words carry the claim. Meanwhile the exact-
// phrase provenance killed every honest PARAPHRASE of a real FACTS metric ("Hiện chỉ 9% đang có số
// liệu") — the very behaviour the prompt teaches ("do not parrot the screen").
//
// So the rule stops inspecting neighbours and licenses THE TOKEN ITSELF, sentence by sentence:
//
//   LAYER 1 — a percentage is speakable only where FACTS can put it: "N%" must be a percentage the
//   record itself WRITES ("9%", "40%" inside prioritized_actions — any paraphrase around it is then
//   free), or N must be a market_demand value AND the sentence must name the field ("nhu cầu thị
//   trường" / "market demand"). A bare "71%" in any other sentence is dead on arrival — whatever
//   the word order, whatever punctuation detaches it, whatever safe word follows it. This is
//   fail-CLOSED over the whole % surface: there is no noun to forget and no anchor to slip.
//   A spelled-out percentage ("bảy mươi mốt phần trăm") has no digits for any gate to check and no
//   licensed form at all — always a claim.
//
//   LAYER 2 — a sentence that contains BOTH a rate token (%/ratio) AND a hiring-market actor is a
//   crowd statistic no matter how the two are arranged ("12/20 của các nhà tuyển dụng…", "Nhu cầu
//   thị trường: 71% và họ đều dùng ATS…"). The field name is stripped before the scan so "nhu cầu
//   thị trường" never counts as the actor "thị trường". This list IS a deny-list and stays
//   fail-open on an unlisted synonym — accepted as defense-in-depth only: an attacker now needs a
//   LICENSED number and an unlisted actor in the same breath, where before either alone sufficed.
//
// Ratios keep the attach check as a third layer, with copulas/comparatives in the safe list — "9/20
// là thấp nhất", "9/20 thấp hơn hẳn 12/20" are the DEFAULT register for reading a score off a scale
// (and fact-vs-fact comparison is promised legal above); the crowd forms they would have caught
// ("12/20 của các nhà tuyển dụng", "71/100 là tỷ lệ nhà tuyển dụng…") are layer-2 kills instead.
const SENT_SPLIT = /(?<=[.!?…])[\s"')\]]+|\n+/u;
const FIELD_NAME = /nhu\s*cầu\s*thị\s*trường|market\s*demand/giu;
const PCT_TOKEN = /(\d+(?:[.,]\d+)?)\s*(?:%|phần\s*trăm|percent(?:age)?s?)/giu;
/** "phần trăm"/"percent" left over after every digit-led form is removed — i.e. the spelled-out
 *  percentage ("bảy mươi mốt phần trăm"), which has no digits for any gate to check and no licensed
 *  form. Only ever run on a sentence already stripped of PCT_TOKEN matches. */
const SPELLED_PCT = /(?<![\p{L}])(?:phần\s*trăm|percent(?:age)?s?)(?![\p{L}])/iu;
/** Hiring-market actors for the co-occurrence veto. "chúng ta/mình" (we) and "họ tên" (full name —
 *  a CV field!) are explicitly carved out; "bạn" stays OFF the list ("9% bullet của bạn" is the
 *  user's own record, not a crowd). */
// Bare "JD" is deliberately NOT an actor: other_matches ARE JDs, so the flagship cross-JD
// comparison ("JD Frontend Developer đang hợp bạn nhất (72/100 so với 64/100 của Backend)") and the
// other-match template line both name it beside a ratio legitimately. "71% JD yêu cầu…" still dies
// at layer 1 — the 71% is unlicensed with or without an actor in sight.
const MARKET_ACTOR =
  /(?<![\p{L}\p{N}])(?:nhà\s+tuyển\s+dụng|bên\s+tuyển|nhà\s+quản\s+lý|phòng\s+nhân\s+sự|hr|headhunters?|recruiters?|employers?|hiring\s+managers?|công\s+ty|doanh\s+nghiệp|compan(?:y|ies)|firms?|tin\s+tuyển\s+dụng|tin\s+đăng|job\s+(?:postings?|ads?|listings?|descriptions?)|mô\s+tả\s+công\s+việc|vị\s+trí\s+tuyển\s+dụng|ứng\s+viên|candidates?|applicants?|thị\s+trường|markets?|người\s+khác|họ(?!\s*tên)|chúng(?!\s*(?:ta|mình))|they|them)(?![\p{L}\p{N}])/giu;
const RATIO_ATTACH = /\d+(?:[.,]\d+)?\s*(?:\/|trên|out\s+of)\s*\d+(?:[.,]\d+)?\s+\(?([\p{L}]+)/giu;
const RATIO_TOKEN = /\d+(?:[.,]\d+)?\s*(?:\/|trên|out\s+of)\s*\d+(?:[.,]\d+)?/giu;
const SAFE_AFTER_RATIO = new Set([
  'điểm',
  'points',
  'point',
  'và',
  'and',
  'cho',
  'for',
  'so',
  'của',
  'với',
  // Copulas and comparatives — the default register for reading a score off its scale. Safe here
  // ONLY because layer 2 vetoes any ratio sentence that also names a market actor.
  'là',
  'is',
  'are',
  'thấp',
  'cao',
  'hơn',
  'kém',
  'mức',
]);

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ');

/** What {@link unverifiableClaim} needs to know about FACTS to license a statistic. */
export interface StatProvenance {
  /** normalize(JSON.stringify(facts)) — phrase haystack for the ratio attach check. */
  haystack: string;
  /** Percentages FACTS write out as strings ("9", "40" from "hiện chỉ 9% bullet có số"). */
  writtenPcts: ReadonlySet<string>;
  /** market_demand values ("71", "30") — speakable ONLY beside the field's name. */
  fieldPcts: ReadonlySet<string>;
}

/** Precompute the statistic-licensing context for {@link unverifiableClaim} once per turn. */
export function statProvenance(facts: DiagnosisFacts): StatProvenance {
  const haystack = normalize(JSON.stringify(facts));
  const writtenPcts = new Set<string>();
  for (const m of haystack.matchAll(PCT_TOKEN)) writtenPcts.add(m[1].replace(',', '.'));
  const fieldPcts = new Set<string>();
  for (const g of facts.gap_items) {
    if (g.market_demand !== null) fieldPcts.add(String(g.market_demand));
  }
  return { haystack, writtenPcts, fieldPcts };
}

const EMPTY_PROVENANCE: StatProvenance = {
  haystack: '',
  writtenPcts: new Set(),
  fieldPcts: new Set(),
};

function attachedStatClaim(text: string, prov: StatProvenance): boolean {
  for (const sentence of text.split(SENT_SPLIT)) {
    const named = FIELD_NAME.test(sentence);
    FIELD_NAME.lastIndex = 0;
    const deFielded = sentence.replace(FIELD_NAME, ' ');
    const hasActor = MARKET_ACTOR.test(deFielded);
    MARKET_ACTOR.lastIndex = 0;

    let hasRate = false;
    for (const m of sentence.matchAll(PCT_TOKEN)) {
      hasRate = true;
      const n = m[1].replace(',', '.');
      const licensed = prov.writtenPcts.has(n) || (named && prov.fieldPcts.has(n));
      if (!licensed) return true;
    }
    // The spelled-out form is checked on the de-%-ed sentence so "71 phần trăm" (digits present,
    // caught above) is not double-counted; what remains is "bảy mươi mốt phần trăm".
    if (sentence.replace(PCT_TOKEN, ' ').match(SPELLED_PCT)) return true;

    for (const m of sentence.matchAll(RATIO_ATTACH)) {
      if (SAFE_AFTER_RATIO.has(m[1].toLowerCase())) continue;
      if (!prov.haystack.includes(normalize(m[0].replace(/\(/g, '')))) return true;
    }
    if (RATIO_TOKEN.test(sentence)) hasRate = true;
    RATIO_TOKEN.lastIndex = 0;

    if (hasRate && hasActor) return true;
  }
  return false;
}

/** The first unverifiable-claim label present in the text, or null. Exported for the calibration
 *  harness: it must name WHY a turn was rejected using the REAL rule, never a copy of it (a stale
 *  private mirror in the smoke once measured pre-fix behaviour and made a working fix look broken).
 *  Omitting `prov` means NOTHING licenses a statistic — the strictest reading. */
export function unverifiableClaim(text: string, prov?: StatProvenance): string | null {
  for (const [label, re] of UNVERIFIABLE_CLAIM) if (re.test(text)) return label;
  if (attachedStatClaim(text, prov ?? EMPTY_PROVENANCE)) return 'peer_stat';
  return null;
}

export function allowedNumberTokens(facts: DiagnosisFacts, conversation?: string): Set<string> {
  const allowed = new Set<string>(['0', '20', '100']);
  const visit = (value: unknown): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      allowed.add(String(value));
    } else if (typeof value === 'string') {
      for (const token of value.match(/\d+(?:[.,]\d+)?/g) ?? []) {
        allowed.add(token.replace(',', '.'));
      }
    } else if (Array.isArray(value)) {
      allowed.add(String(value.length));
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(facts);

  // FACTS is not the only honest source of a number: so is what the candidate just SAID. Told "mình
  // còn đúng 2 tuần trước deadline", the advisor must be able to say "2 tuần" back — otherwise "2"
  // reads as fabricated and the whole reply is swapped for a template. Measured: the memory persona
  // lost 4 of 5 turns this way, so remembering was impossible even once the citation gate was gone.
  //
  // TRADE-OFF, accepted deliberately: a number the candidate PLANTS ("CV tôi 95 điểm đúng không?")
  // becomes speakable, so the model could echo 95 back. That is bounded — the user already knows what
  // they typed, and the prompt still requires every CV/score number to come from FACTS. The gate has
  // always been token-level (it checks provenance, never what a number is ASSERTED to mean), so this
  // widens an existing seam rather than opening a new kind of one.
  if (conversation) {
    for (const token of conversation.match(/\d+(?:[.,]\d+)?/g) ?? []) {
      allowed.add(token.replace(',', '.'));
    }
  }
  return allowed;
}

/** Every number in `text` that FACTS (+ what the candidate said) cannot account for. Exported so the
 *  calibration harness can NAME the token that cost a turn instead of guessing at it. */
export function ungroundedNumbers(text: string, allowed: Set<string>): string[] {
  const ungrounded = new Set<string>();
  for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const token = match[0].replace(',', '.');
    if (allowed.has(token)) continue;
    if (isBenignQuantity(text, match.index, match[0])) continue;
    ungrounded.add(token);
  }
  return [...ungrounded];
}

function numbersGrounded(text: string, allowed: Set<string>): boolean {
  return ungroundedNumbers(text, allowed).length === 0;
}

/**
 * The anti-fabrication boundary. Treats the parsed model output as PROSE ONLY:
 *  - message empty / not an object → deterministic {@link fallback} (grounded in top_summary, localized).
 *  - cited_dimension kept ONLY if it is one of the 4 real dimension keys (else dropped).
 *  - cited_gap_id kept ONLY if it is a requirement_id present in facts.gap_items (else dropped).
 *  - message + suggested_next_step run through the raw-URL backstop.
 *
 * `language` is threaded to the fallback ONLY (the model already phrases the happy-path message in the
 * user's language); 'en' → English framing, anything else (default / 'vi' / undefined) → Vietnamese.
 */
export function groundDiagnosis(
  parsed: unknown,
  facts: DiagnosisFacts,
  language?: string,
  /** This turn's question + prior history. Numbers the candidate already said are speakable —
   *  without this the advisor cannot repeat "2 tuần" back and every memory turn is templated. */
  conversation?: string,
): DiagnosisChatResult {
  if (typeof parsed !== 'object' || parsed === null) return fallback(facts, language);
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message !== 'string' || obj.message.trim() === '')
    return fallback(facts, language);

  const dimKeys = new Set<string>(DIAGNOSIS_DIMENSION_KEYS);
  const dimension =
    typeof obj.cited_dimension === 'string' && dimKeys.has(obj.cited_dimension)
      ? facts.dimensions.find((d) => d.key === obj.cited_dimension)
      : undefined;

  const gapIds = new Set(facts.gap_items.map((g) => g.requirement_id));
  const gap =
    typeof obj.cited_gap_id === 'string' && gapIds.has(obj.cited_gap_id)
      ? facts.gap_items.find((g) => g.requirement_id === obj.cited_gap_id)
      : undefined;

  const otherIndex =
    typeof obj.cited_other_match_index === 'number' && Number.isInteger(obj.cited_other_match_index)
      ? obj.cited_other_match_index - 1
      : -1;
  const otherMatch =
    otherIndex >= 0 && facts.other_matches ? facts.other_matches[otherIndex] : undefined;

  const citedTool = typeof obj.cited_tool === 'string' ? obj.cited_tool : undefined;
  const toolResult =
    citedTool && facts.tool_results && citedTool in facts.tool_results
      ? { toolName: citedTool, data: facts.tool_results[citedTool] }
      : undefined;

  // Advisor v3: a citation is a SCROLL TARGET, not a licence to speak. Requiring one meant every
  // turn that legitimately has nothing to cite was thrown away and answered with "Mình chưa đủ dữ
  // kiện đã xác minh" — including the ones that make a companion feel alive. Measured over 25 real
  // multi-turn exchanges: "Bạn vừa nói mình nhắm vị trí gì ấy nhỉ?" and "Bạn có nhớ deadline còn 2
  // tuần không?" both hit it, so the advisor could never once discuss the conversation it was
  // having — it read as amnesia, not caution. Small talk and clarifying questions died the same way.
  //
  // The gate also bought nothing it claimed to: it inspects a metadata FIELD, never the prose, so a
  // message that cites a real gap can still fabricate freely — while an honest uncited answer is
  // killed. What actually guards the prose is the number gate plus the unverifiable-claim gate below.
  const allowed = allowedNumberTokens(facts, conversation);
  // Facts only, NOT the conversation: a candidate who plants "71% nhà tuyển dụng dùng ATS đúng
  // không?" must not license the advisor to confirm it back. (The number gate does accept the
  // candidate's own bare numbers — a deadline is theirs to state; a population statistic is not.)
  const prov = statProvenance(facts);
  const modelMessage = stripRawUrls(obj.message);
  const unverifiable = unverifiableClaim(modelMessage, prov);
  if (!unverifiable && numbersGrounded(modelMessage, allowed)) {
    const rawSuggestion =
      typeof obj.suggested_next_step === 'string' ? obj.suggested_next_step.trim() : '';
    // Held to BOTH gates, exactly like the message. suggested_next_step is rendered as the chip the
    // user taps, and it is persisted and replayed into {{history}} — so an unverifiable claim here
    // would be the identical sentence the gate refuses one field to the left, but clickable.
    const suggestionOk =
      rawSuggestion !== '' &&
      !unverifiableClaim(rawSuggestion, prov) &&
      numbersGrounded(rawSuggestion, allowed);
    // Verified default when the model's suggestion is absent/ungrounded — same sources the
    // template uses: the cited gap's next action, else the top prioritized action.
    const verifiedSuggestion =
      gap?.recommended_next_action ?? facts.top_summary.prioritized_actions[0] ?? null;
    return {
      answer: modelMessage,
      ...(dimension ? { cited_dimension: dimension.key } : {}),
      ...(gap ? { cited_gap_id: gap.requirement_id } : {}),
      ...(otherMatch ? { cited_other_match_index: otherIndex + 1 } : {}),
      ...(toolResult ? { cited_tool: citedTool as string } : {}),
      suggested_next_step: suggestionOk ? stripRawUrls(rawSuggestion) : verifiedSuggestion,
    };
  }

  // A gate failed — the model asserted something FACTS cannot back. Serve the warm, reason-aware
  // refusal (Phase A) instead of a fact template: the refusal names what it won't guess, then
  // pivots to a verified hook, keeping whichever citation resolved so the FE still scrolls.
  return buildRefusal(
    unverifiable ?? 'numbers',
    {
      dimension,
      gap,
      ...(otherMatch ? { otherMatch: { fact: otherMatch, index1: otherIndex + 1 } } : {}),
      toolResult,
    },
    facts,
    language,
  );
}
