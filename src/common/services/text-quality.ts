/**
 * Deterministic text-quality assessment — the shared core behind every AI input gate
 * (rewrite fields, uploaded CV text, pasted JD text). Garbage must never reach an LLM:
 * it burns platform cost AND the user's quota (platform records usage only after success).
 *
 * Pure + Unicode-aware (Vietnamese-safe; no vowel heuristics that would kill SQL/HTML).
 */

export interface TextQualityOptions {
  /** Minimum count of meaningful tokens (see isMeaningful). */
  minMeaningfulTokens: number;
  /** Minimum total \p{L}+\p{N} characters across meaningful tokens. */
  minMeaningfulChars: number;
}

export interface TextQualityVerdict {
  ok: boolean;
  meaningful_tokens: number;
  meaningful_chars: number;
}

/** Junk tokens that carry zero CV/JD signal — placeholder/test input. Case-insensitive. */
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

/** A token that is one character repeated ("aaa", "XXX"). */
const SINGLE_CHAR_REPEAT = /^(.)\1+$/;
const LETTER_OR_NUM = /\p{L}|\p{N}/u;
const LETTER = /\p{L}/u;

/**
 * The unique-token-ratio spam rule ("test test test") only makes sense on SHORT inputs:
 * long real prose legitimately repeats words (a full Vietnamese CV can dip under any ratio),
 * so the rule is bounded to inputs of at most this many tokens.
 */
const RATIO_RULE_MAX_TOKENS = 12;
const RATIO_RULE_MIN_TOKENS = 3;
const MIN_UNIQUE_RATIO = 0.34;

function isMeaningful(token: string): boolean {
  if (token.length < 2) return false;
  if (SINGLE_CHAR_REPEAT.test(token)) return false;
  if (JUNK_BLOCKLIST.has(token.toLowerCase())) return false;
  if (!LETTER.test(token)) return false;
  return true;
}

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
 * FAIL when:
 *  1. short repetitive spam — 3..12 tokens with unique/total <= 0.34 ("test test test"), or
 *  2. thin content — meaningfulTokens < minMeaningfulTokens AND meaningfulChars < minMeaningfulChars.
 */
export function assessTextQuality(text: string, opts: TextQualityOptions): TextQualityVerdict {
  const tokens = (text ?? '').trim().split(/\s+/).filter(Boolean);

  const meaningful = tokens.filter(isMeaningful);
  const verdictBase = {
    meaningful_tokens: meaningful.length,
    meaningful_chars: countLetterAndNumChars(meaningful),
  };

  if (tokens.length >= RATIO_RULE_MIN_TOKENS && tokens.length <= RATIO_RULE_MAX_TOKENS) {
    const unique = new Set(tokens.map((t) => t.toLowerCase())).size;
    if (unique / tokens.length <= MIN_UNIQUE_RATIO) return { ok: false, ...verdictBase };
  }

  if (
    verdictBase.meaningful_tokens < opts.minMeaningfulTokens &&
    verdictBase.meaningful_chars < opts.minMeaningfulChars
  ) {
    return { ok: false, ...verdictBase };
  }

  return { ok: true, ...verdictBase };
}
