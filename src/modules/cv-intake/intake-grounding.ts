// src/modules/cv-intake/intake-grounding.ts
import { NAMED_TECH, hasWord, numberTokens } from '../cv-assistant/cv-assistant-rewrite';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
// Phrase normalization for contiguous matching: keep letters+digits, punctuation → space, collapse.
const normPhrase = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * True iff `value` is supported by `narrative` (anti-fabrication gate).
 *  - mode 'atom' (company/position — a single named entity): the value must appear as a CONTIGUOUS
 *    phrase. Scattered or substring words are NOT enough — a fabricated "Smart Solutions" recombined
 *    from "Smart Data" + "Cloud Solutions", or "App Net" from "Apple"/"network", is rejected.
 *  - mode 'prose' (description/achievements): every alphabetic word must appear as a WHOLE WORD
 *    (whole-word, not substring) — looser, since prose paraphrases the narrative.
 * Both modes additionally require every number+unit token and every NAMED_TECH in the value to appear.
 */
export function isGrounded(
  value: string,
  narrative: string,
  mode: 'atom' | 'prose' = 'prose',
): boolean {
  // (a) every number+unit token in value must appear in the narrative.
  const allowed = new Set(numberTokens(narrative));
  for (const tok of numberTokens(value)) if (!allowed.has(tok)) return false;
  // (b) every known specific tech in value must appear in the narrative.
  for (const tech of NAMED_TECH)
    if (hasWord(value, tech) && !hasWord(narrative, tech)) return false;
  if (mode === 'atom') {
    // (c-atom) the whole value must appear as a contiguous phrase in the narrative.
    const phrase = normPhrase(value);
    if (phrase.length >= 2 && !normPhrase(narrative).includes(phrase)) return false;
  } else {
    // (c-prose) every alphabetic word (≥3 chars) must appear as a WHOLE WORD in the narrative.
    const words = norm(value)
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length >= 3);
    for (const w of words) if (!hasWord(narrative, w)) return false;
  }
  return true;
}
