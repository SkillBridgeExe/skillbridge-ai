// src/modules/cv-intake/intake-grounding.ts
import { NAMED_TECH, hasWord, numberTokens } from '../cv-assistant/cv-assistant-rewrite';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function isGrounded(value: string, narrative: string): boolean {
  const src = norm(narrative);
  // (a) every number+unit token in value must appear in the narrative.
  const allowed = new Set(numberTokens(narrative));
  for (const tok of numberTokens(value)) if (!allowed.has(tok)) return false;
  // (b) every known specific tech in value must appear in the narrative.
  for (const tech of NAMED_TECH)
    if (hasWord(value, tech) && !hasWord(narrative, tech)) return false;
  // (c) every alphabetic word (≥3 chars) of the value must appear in the narrative — catches a
  //     fabricated company/title; numbers/units already handled by (a), so split on non-letters.
  const words = norm(value)
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3);
  for (const w of words) if (!src.includes(w)) return false;
  return true;
}
