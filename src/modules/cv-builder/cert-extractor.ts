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

// Cut a captured cert name at the first coordinating connective and cap its length,
// so a match near a segment's end doesn't swallow unrelated trailing prose.
function boundName(raw: string): string {
  const cut = raw
    .split(/\s+(?:và|and)\s+/i)[0]
    .replace(/\s+/g, ' ')
    .trim();
  return cut.slice(0, 80).trim();
}

/**
 * Deterministic certification extraction. Each clause is fine-split into segments so a date binds to the
 * cert in its OWN segment, never a sibling cert's. Date falls back to a strictly date-only following
 * segment (covers "AWS Certified X, cấp 03/2023"). Pure — no LLM, no fabrication.
 */
export function extractCerts(narrative: string): ExtractedCert[] {
  const patterns = loadPatterns();
  const compiled = patterns.map((p) => ({ p, re: new RegExp(p.issuer_regex, 'i') }));
  const out: ExtractedCert[] = [];
  const seen = new Set<string>();
  for (const clause of clauses(narrative)) {
    const segments = clause
      .split(/[,(]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      for (const { p, re } of compiled) {
        const m = re.exec(seg);
        if (!m) continue;
        // Date: this segment first; else borrow a strictly date-only NEXT segment,
        // never one that itself holds another cert.
        let start = parseDateRange(seg).start;
        if (!start && i + 1 < segments.length) {
          const next = segments[i + 1];
          if (!compiled.some((c) => c.re.test(next))) start = parseDateRange(next).start;
        }
        const name = boundName(seg.slice(m.index)) || m[0];
        const key = `${p.id}:${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, issuer: p.issuer, date: start, matched_pattern: p.id });
      }
    }
  }
  return out;
}
