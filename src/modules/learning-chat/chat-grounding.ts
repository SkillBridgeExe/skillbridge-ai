import { GapItem } from '../gap-engine/gap-item';
import { RetrievedResource } from '../roadmap/resource-embedding';

/**
 * Anti-fabrication core of the learning chatbot (pure, no LLM, no IO). The LLM only PHRASES an answer
 * over a fixed retrieved set; these functions own grounding:
 *  - groundResources: keep only cited ids that are in the retrieved set (drop hallucinated ids), strip any
 *    raw URL from the prose (links resolve from resource_id — a raw link is never trusted), dedupe, and
 *    fall back deterministically on bad/empty model output. A fabricated course/link cannot reach the user.
 *  - buildChatFacts: the deterministic allow-list of the user's own open gaps (skill + severity + status),
 *    read-only, so the answer is grounded in THEIR situation without leaking anything else.
 */

export interface ChatFact {
  skill: string;
  severity: number;
  status: string;
}

export interface ChatFacts {
  open_gaps: ChatFact[];
}

export interface GroundedAnswer {
  message: string;
  cited_resources: RetrievedResource[];
  suggested_next_step: string | null;
}

const MAX_GAPS = 5;
const MAX_MESSAGE_LEN = 1500;
/** Any http(s):// or www. link — stripped from prose so the user only ever follows a catalog-resolved url. */
const RAW_URL = /\b(?:https?:\/\/|www\.)\S+/gi;

/** Top open gaps (skill + severity + status only — PII-free), highest severity first, capped. */
export function buildChatFacts(input: {
  gapItems?: Pick<GapItem, 'canonical_name' | 'cv_status' | 'severity'>[];
}): ChatFacts {
  const open_gaps = (input.gapItems ?? [])
    .filter((g) => g.cv_status !== 'matched')
    .slice()
    .sort((a, b) => b.severity - a.severity)
    .slice(0, MAX_GAPS)
    .map((g) => ({ skill: g.canonical_name, severity: g.severity, status: g.cv_status }));
  return { open_gaps };
}

function stripRawUrls(message: string): string {
  return message
    .replace(RAW_URL, '[link]')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LEN);
}

export function groundResources(
  parsed: unknown,
  retrieved: RetrievedResource[],
  _facts: ChatFacts,
): GroundedAnswer {
  const fallback = (): GroundedAnswer => ({
    message:
      retrieved.length > 0
        ? 'Mình chưa chắc câu trả lời tốt nhất — đây là các tài nguyên gần nhất trong danh mục.'
        : 'Mình chưa có tài nguyên phù hợp cho phần này trong danh mục — bạn xem lại lộ trình của mình nhé.',
    cited_resources: retrieved,
    suggested_next_step: null,
  });

  if (typeof parsed !== 'object' || parsed === null) return fallback();
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message !== 'string' || obj.message.trim() === '') return fallback();

  const byId = new Map(retrieved.map((r) => [r.resource_id, r]));
  const citedIds = Array.isArray(obj.cited_resource_ids) ? obj.cited_resource_ids : [];
  const seen = new Set<string>();
  const cited_resources: RetrievedResource[] = [];
  for (const id of citedIds) {
    if (typeof id !== 'string') continue;
    const r = byId.get(id);
    if (r && !seen.has(id)) {
      seen.add(id);
      cited_resources.push(r);
    }
  }

  const suggested_next_step =
    typeof obj.suggested_next_step === 'string' && obj.suggested_next_step.trim() !== ''
      ? obj.suggested_next_step.trim()
      : null;

  return { message: stripRawUrls(obj.message), cited_resources, suggested_next_step };
}
