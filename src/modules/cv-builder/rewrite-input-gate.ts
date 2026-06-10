/**
 * Deterministic input-quality gate for CvRewriteService.
 *
 * Garbage must never reach the LLM — it burns platform cost AND the user's own quota.
 * Platform records usage only after a successful rewrite; a gate rejection before
 * cache/LLM/tracing ensures zero quota impact on junk inputs.
 */

export interface InputQualityVerdict {
  ok: boolean;
  reason?: 'INSUFFICIENT_CONTEXT';
}

/**
 * Junk token blocklist — case-insensitive.
 * These words carry zero CV signal; a section consisting only of them
 * (possibly repeated) is clearly placeholder / test input.
 */
const JUNK_BLOCKLIST = new Set([
  'test',
  'asdf',
  'qwerty',
  'lorem',
  'ipsum',
  'abc',
  'xyz',
  'aaa',
  'sss',
  'ddd',
  'foo',
  'bar',
  'baz',
]);

/** Matches a token that is a single character repeated (e.g. "aaa", "XXX"). */
const SINGLE_CHAR_REPEAT = /^(.)\1+$/;

/** Unicode letter or number (ES2022 + u flag). */
const LETTER_OR_NUM = /\p{L}|\p{N}/u;
const LETTER = /\p{L}/u;

/**
 * Returns true when the token is "meaningful" for quality assessment:
 *  - length >= 2
 *  - not a single repeated character
 *  - not in the junk blocklist
 *  - contains at least one Unicode letter
 */
function isMeaningful(token: string): boolean {
  if (token.length < 2) return false;
  if (SINGLE_CHAR_REPEAT.test(token)) return false;
  if (JUNK_BLOCKLIST.has(token.toLowerCase())) return false;
  if (!LETTER.test(token)) return false;
  return true;
}

/**
 * Count \p{L} + \p{N} characters across an array of tokens.
 */
function countLetterAndNumChars(tokens: string[]): number {
  let count = 0;
  for (const t of tokens) {
    for (const ch of t) {
      if (LETTER_OR_NUM.test(ch)) count++;
    }
  }
  return count;
}

/**
 * Assess whether `text` contains enough real content for an AI rewrite.
 *
 * FAIL when:
 *  1. meaningfulTokens < 4 AND meaningfulChars < 25  (sparse / thin input)
 *  2. tokens.length >= 3 AND uniqueTokens/tokens.length <= 0.34  (repetitive spam)
 *
 * Both checks are case-insensitive and Unicode-aware (handles Vietnamese).
 */
export function assessRewriteInput(text: string): InputQualityVerdict {
  const tokens = text.trim().split(/\s+/);

  // unique-ratio check (catches "test test test", "react react react react")
  if (tokens.length >= 3) {
    const uniqueTokens = new Set(tokens.map((t) => t.toLowerCase())).size;
    if (uniqueTokens / tokens.length <= 0.34) {
      return { ok: false, reason: 'INSUFFICIENT_CONTEXT' };
    }
  }

  const meaningfulTokens = tokens.filter(isMeaningful);
  const meaningfulChars = countLetterAndNumChars(meaningfulTokens);

  if (meaningfulTokens.length < 4 && meaningfulChars < 25) {
    return { ok: false, reason: 'INSUFFICIENT_CONTEXT' };
  }

  return { ok: true };
}
