import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { SkillBridgeGapReport } from '../gap-report/gap-report.service';

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
}

export interface DiagnosisChatResult {
  answer: string;
  cited_dimension?: DiagnosisDimensionKey;
  cited_gap_id?: string;
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

function renderGroundedAnswer(input: {
  dimension?: DiagnosisDimensionFact;
  gap?: DiagnosisGapFact;
  facts: DiagnosisFacts;
  language?: string;
}): DiagnosisChatResult {
  const isEn = isEnglish(input.language);
  const parts: string[] = [];
  let suggested_next_step: string | null = null;

  if (input.dimension) {
    parts.push(
      isEn
        ? `Verified CV dimension: ${input.dimension.key} is ${input.dimension.score20}/20. ${input.dimension.rationale}`.trim()
        : `Mục đã xác minh: ${input.dimension.key} đang ở ${input.dimension.score20}/20. ${input.dimension.rationale}`.trim(),
    );
    suggested_next_step = input.facts.top_summary.prioritized_actions[0] ?? null;
  }

  if (input.gap) {
    const demand =
      input.gap.market_demand === null
        ? ''
        : isEn
          ? ` Market demand: ${input.gap.market_demand}%.`
          : ` Nhu cầu thị trường: ${input.gap.market_demand}%.`;
    parts.push(
      isEn
        ? `Verified gap: ${input.gap.display_name} is ${input.gap.cv_status}; priority ${input.gap.severity}.${demand} Next action: ${input.gap.recommended_next_action}.`
        : `Gap đã xác minh: ${input.gap.display_name} đang là ${input.gap.cv_status}; độ ưu tiên ${input.gap.severity}.${demand} Bước tiếp theo: ${input.gap.recommended_next_action}.`,
    );
    suggested_next_step = input.gap.recommended_next_action;
  }

  return {
    answer: stripRawUrls(parts.join(' ')),
    ...(input.dimension ? { cited_dimension: input.dimension.key } : {}),
    ...(input.gap ? { cited_gap_id: input.gap.requirement_id } : {}),
    suggested_next_step,
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
    }));

  return {
    overall_score: numOrNull(review?.overall_score),
    ats_score: numOrNull(review?.ats_rule_score),
    dimensions,
    top_summary: { prioritized_actions },
    gap_items,
  };
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
    answer = isEn
      ? `Based on your CV diagnosis, here are the actions to prioritize: ${list}.`
      : `Dựa trên kết quả chẩn đoán CV của bạn, đây là những việc nên ưu tiên: ${list}.`;
  } else {
    answer = isEn
      ? "I don't have enough diagnosis data to answer specifically yet — please re-run your CV diagnosis and ask again."
      : 'Mình chưa có đủ dữ liệu chẩn đoán để trả lời cụ thể — bạn hãy chạy lại phần chẩn đoán CV rồi hỏi lại nhé.';
  }
  return { answer: stripRawUrls(answer) };
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

  if (!dimension && !gap) return fallback(facts, language);

  return renderGroundedAnswer({ dimension, gap, facts, language });
}
