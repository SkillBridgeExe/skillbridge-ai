/**
 * MEASURE M6 — prompt-injection sanitizer for user free-text entering LLM prompts.
 *
 * User-pasted JD / CV / answer text is DATA, not instructions. The primary control is prompt
 * design; this is the deterministic backstop (pattern borrowed from Resume-Matcher
 * `improver.py:_sanitize_user_input`, and a superset of the INSTRUCTION_LIKE regex used for
 * chat tool results in `src/infrastructure/tools/injection-defense.ts` — kept separate so the
 * chat-loop's pinned behavior is untouched).
 *
 * Wired at the single chokepoint every production prompt renders through:
 * `PromptsService.render()`. Only template VARS are sanitized — template bodies are trusted.
 * Redactions are surfaced by the caller (log), never silent; benign text passes byte-identical.
 */

const INJECTION_PATTERNS: RegExp[] = [
  // English
  /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|previous|above|prior|earlier)\s+)+(?:instructions?|prompts?|rules?)\b/gi,
  /\bsystem\s+prompt\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\bnew\s+instructions?\s*:/gi,
  /^[ \t]*system\s*:/gim,
  /\[\/?INST\]/gi,
  /<\/?\s*system\s*>/gi,
  /<<\s*\/?\s*SYS\s*>>/gi,
  /\bpretend\s+(?:to\s+be|you\s+are)\b/gi,
  /\bjailbreak\b/gi,
  // Vietnamese (multi-word phrases; no \b — JS word boundaries are unreliable around diacritics)
  /(?:bỏ qua|quên|phớt lờ)\s+(?:hết\s+|tất cả\s+|mọi\s+|các\s+|những\s+)*(?:hướng dẫn|chỉ dẫn|chỉ thị|mệnh lệnh|quy tắc)/gi,
  /bạn\s+(?:bây\s+)?giờ\s+là/gi,
  // imperative only — "đóng vai trò ..." ("play a role in the team") is everyday JD language
  /hãy\s+đóng\s+vai(?!\s*trò)/gi,
  /giả\s+vờ\s+(?:là|rằng|bạn)/gi,
];

export interface SanitizedText {
  text: string;
  redactions: string[];
}

export interface SanitizedVars {
  vars: Record<string, unknown>;
  redactions: string[];
}

export function sanitizePromptText(text: string): SanitizedText {
  const redactions: string[] = [];
  let out = text;
  for (const pattern of INJECTION_PATTERNS) {
    out = out.replace(pattern, (match) => {
      redactions.push(match);
      return '[redacted]';
    });
  }
  return { text: out, redactions };
}

/**
 * Sanitize every template var (strings directly; objects/arrays via JSON round-trip so nested
 * strings are covered). Returns the ORIGINAL object untouched when nothing matched, so the
 * benign path is provably mutation-free.
 */
export function sanitizePromptVars(vars: Record<string, unknown>): SanitizedVars {
  const redactions: string[] = [];
  const out: Record<string, unknown> = {};
  let mutated = false;

  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === 'string') {
      const result = sanitizePromptText(value);
      if (result.redactions.length > 0) {
        redactions.push(...result.redactions);
        mutated = true;
      }
      out[key] = result.text;
    } else if (value !== null && typeof value === 'object') {
      const result = sanitizePromptText(JSON.stringify(value));
      if (result.redactions.length > 0) {
        redactions.push(...result.redactions);
        out[key] = JSON.parse(result.text) as unknown;
        mutated = true;
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }

  return { vars: mutated ? out : vars, redactions };
}
