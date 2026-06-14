/**
 * PURE text-quality metrics over extracted CV text. No I/O, no NestJS injection, no LLM.
 * The skill scan is INJECTED (a `(text) => {canonical_name}[]` fn) so this is unit-testable
 * without the taxonomy/DB.
 *
 * This is the SINGLE SOURCE OF TRUTH for the mojibake / word-like / skill-density signals. Two
 * consumers share it: the extractor A/B harness (src/calibration/extractor-metrics.ts re-exports
 * the ExtractorMetrics subset) and the per-review `extraction_quality` signal
 * (src/common/services/extraction-quality.ts). Keeping ONE implementation means the eval report and
 * the live signal can never silently disagree.
 */
export interface TextMetrics {
  /** total characters. */
  charCount: number;
  /** number of lines (0 for empty text). */
  lineCount: number;
  /** whitespace-split tokens (non-empty). */
  wordCount: number;
  /** non-whitespace chars / total chars (0..1). */
  nonWsRatio: number;
  /** U+FFFD replacement chars + common UTF-8-mis-decode sequences (Vietnamese breakage). */
  mojibakeCount: number;
  /** mojibakeCount / charCount (0..1). 0 for empty text. */
  mojibakeRatio: number;
  /** whitespace tokens that look like words/identifiers / total tokens (0..1). */
  wordlikeRatio: number;
  /** distinct canonical skills the gazetteer found. */
  skillsFound: number;
  skillCanonicals: string[];
}

// U+FFFD, plus the classic Mojibake signatures of UTF-8 decoded as Latin-1 ("Ã©", "â€", "Â ").
const MOJIBAKE_RE = /�|Ã[-¿]|â€|Â[-¿]/g;
// A token is "word-like" if it starts alnum (any script incl. Vietnamese) then alnum/.+#_- .
const WORDLIKE_RE = /^[\p{L}\p{N}][\p{L}\p{N}.+#_-]*$/u;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function computeTextMetrics(
  text: string,
  scan: (t: string) => { canonical_name: string }[],
): TextMetrics {
  const charCount = text.length;
  const lineCount = text.length === 0 ? 0 : text.split('\n').length;
  const nonWs = text.replace(/\s/g, '').length;
  const nonWsRatio = charCount === 0 ? 0 : round3(nonWs / charCount);
  const mojibakeCount = (text.match(MOJIBAKE_RE) ?? []).length;
  const mojibakeRatio = charCount === 0 ? 0 : round3(mojibakeCount / charCount);
  const tokens = text.split(/\s+/).filter(Boolean);
  const wordlike = tokens.filter((t) => WORDLIKE_RE.test(t)).length;
  const wordlikeRatio = tokens.length === 0 ? 0 : round3(wordlike / tokens.length);
  const skillCanonicals = [...new Set(scan(text).map((s) => s.canonical_name))].sort();
  return {
    charCount,
    lineCount,
    wordCount: tokens.length,
    nonWsRatio,
    mojibakeCount,
    mojibakeRatio,
    wordlikeRatio,
    skillsFound: skillCanonicals.length,
    skillCanonicals,
  };
}
