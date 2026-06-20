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
/** Markdown link [text](url) → keep only the text, so stripping the url never leaves a dangling bracket. */
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
/**
 * Any link-shaped token the bot must never surface as a raw destination — links resolve from resource_id,
 * so the user must never get a typeable/clickable host the catalog didn't verify. Covers: any scheme://
 * (http/https/ftp/defanged), www., a host.tld/PATH (the path is the strong link signal — avoids false
 * positives on tech terms like "Node.js"/"socket.io" which have no path), and common bare course providers
 * / link shorteners that an LLM emits from training data. The PRIMARY control is the prompt forbidding URLs;
 * this is the deterministic backstop.
 */
const URL_LIKE = new RegExp(
  [
    '\\b[a-z][a-z0-9+.\\-]*:\\/\\/\\S+',
    '\\bwww\\.\\S+',
    '\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}\\/\\S*',
    '\\b(?:bit\\.ly|youtu\\.be|t\\.co|goo\\.gl|tinyurl\\.com|udemy\\.com|coursera\\.org|edx\\.org|udacity\\.com|pluralsight\\.com|freecodecamp\\.org|youtube\\.com|w3schools\\.com|geeksforgeeks\\.org)(?:\\/\\S*)?',
  ].join('|'),
  'gi',
);

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

function stripRawUrls(text: string): string {
  return text
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL_LIKE, '[link]')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LEN);
}

export function groundResources(
  parsed: unknown,
  retrieved: RetrievedResource[],
  // FACTS is the PROMPT-side allow-list (rendered into user_context); groundResources does NOT post-verify
  // free-text skill/gap mentions in the prose (that grounding is prompt-only by design). Kept for that contract.
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

  // suggested_next_step is user-visible too → run it through the SAME url backstop as message.
  const suggested_next_step =
    typeof obj.suggested_next_step === 'string' && obj.suggested_next_step.trim() !== ''
      ? stripRawUrls(obj.suggested_next_step)
      : null;

  return { message: stripRawUrls(obj.message), cited_resources, suggested_next_step };
}
