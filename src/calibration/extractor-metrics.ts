/**
 * PURE quality metrics over text extracted from a CV PDF. No I/O. The skill scan is INJECTED
 * (a `(text) => {canonical_name}[]` fn) so this is unit-testable without the taxonomy/DB.
 * `skillsFound` is the primary signal: cleaner / correctly-ordered text recognizes more skills.
 */
export interface ExtractorMetrics {
  charCount: number;
  lineCount: number;
  /** non-whitespace chars / total chars (0..1). */
  nonWsRatio: number;
  /** U+FFFD replacement chars + common UTF-8-mis-decode sequences (Vietnamese breakage). */
  mojibakeCount: number;
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

export function computeMetrics(
  text: string,
  scan: (t: string) => { canonical_name: string }[],
): ExtractorMetrics {
  const charCount = text.length;
  const lineCount = text.length === 0 ? 0 : text.split('\n').length;
  const nonWs = text.replace(/\s/g, '').length;
  const nonWsRatio = charCount === 0 ? 0 : round3(nonWs / charCount);
  const mojibakeCount = (text.match(MOJIBAKE_RE) ?? []).length;
  const tokens = text.split(/\s+/).filter(Boolean);
  const wordlike = tokens.filter((t) => WORDLIKE_RE.test(t)).length;
  const wordlikeRatio = tokens.length === 0 ? 0 : round3(wordlike / tokens.length);
  const skillCanonicals = [...new Set(scan(text).map((s) => s.canonical_name))].sort();
  return {
    charCount,
    lineCount,
    nonWsRatio,
    mojibakeCount,
    wordlikeRatio,
    skillsFound: skillCanonicals.length,
    skillCanonicals,
  };
}
