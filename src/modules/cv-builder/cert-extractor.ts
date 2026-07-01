import * as fs from 'fs';
import * as path from 'path';
import { parseDateRange } from '../cv-intake/intake-dates';

export interface ExtractedCert {
  name: string;
  issuer: string | null;
  date: string | null;
  matched_pattern: string | null;
}

interface CertPattern {
  id: string;
  issuer: string;
  issuer_regex: string;
}

let PATTERNS: CertPattern[] | null = null;
function loadPatterns(): CertPattern[] {
  if (PATTERNS) return PATTERNS;
  const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'cert-patterns.json'), 'utf-8');
  PATTERNS = (JSON.parse(raw) as { patterns: CertPattern[] }).patterns;
  return PATTERNS;
}

// Split the narrative into clauses so a date near one cert mention doesn't leak to another.
function clauses(text: string): string[] {
  return text
    .split(/[.;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Deterministic certification extraction: scan each clause for a known issuer pattern; the date is
 * whatever `parseDateRange` finds in that same clause (never invented). Pure — no LLM, no fabrication.
 */
export function extractCerts(narrative: string): ExtractedCert[] {
  const patterns = loadPatterns();
  const out: ExtractedCert[] = [];
  const seen = new Set<string>();
  for (const clause of clauses(narrative)) {
    for (const p of patterns) {
      const re = new RegExp(p.issuer_regex, 'i');
      const m = re.exec(clause);
      if (!m) continue;
      const key = `${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { start } = parseDateRange(clause);
      // The cert "name" is the matched phrase plus a little trailing context up to the next comma.
      const tail = clause.slice(m.index).split(/[,(]/)[0].trim();
      out.push({ name: tail || m[0], issuer: p.issuer, date: start, matched_pattern: p.id });
    }
  }
  return out;
}
