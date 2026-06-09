import { CanonicalCvDocument } from '../types/canonical-cv';
import { ScannedSkill } from './skill-text-scanner.service';

export type EvidenceKind = 'experience' | 'project' | 'activity' | 'summary' | 'skills_list';
export type EvidenceStrength = 'demonstrated' | 'mentioned' | 'listed_only';

export interface EvidenceSource {
  kind: EvidenceKind;
  ref: string;
  recency_year: number | null;
}
export interface EvidenceItem {
  skill_canonical: string;
  display_name: string;
  sources: EvidenceSource[];
  strength: EvidenceStrength;
  most_recent_year: number | null;
}
export interface EvidenceLedger {
  items: EvidenceItem[];
  evidence_gap: string[];
}

const DEMONSTRATED_KINDS: ReadonlySet<EvidenceKind> = new Set([
  'experience',
  'project',
  'activity',
]);
const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  demonstrated: 0,
  mentioned: 1,
  listed_only: 2,
};

/** Last 4-digit year in a free-text date; "Present"/"Hiện tại"/"now" → nowYear; else null.
 *  Local helper (NOT imported from seniority.ts — that lives on the unmerged #34 branch). */
function recencyYear(end: string | null, nowYear: number): number | null {
  if (!end) return null;
  if (/present|hiện tại|hiện nay|now/i.test(end)) return nowYear;
  const m = end.match(/(?:19|20)\d{2}/g);
  return m && m.length ? Number(m[m.length - 1]) : null;
}

interface Section {
  kind: EvidenceKind;
  ref: string;
  recency_year: number | null;
  text: string;
}

function sectionsOf(doc: CanonicalCvDocument, nowYear: number): Section[] {
  const out: Section[] = [];
  for (const e of doc.experience ?? []) {
    out.push({
      kind: 'experience',
      ref: e.role ? `${e.org} — ${e.role}` : e.org,
      recency_year: recencyYear(e.end, nowYear),
      text: [e.role ?? '', ...(e.bullets ?? [])].join(' '),
    });
  }
  for (const p of doc.projects ?? []) {
    out.push({
      kind: 'project',
      ref: p.name,
      recency_year: null,
      text: [p.name, ...(p.bullets ?? []), ...(p.tech ?? [])].join(' '),
    });
  }
  for (const a of doc.activities ?? []) {
    out.push({
      kind: 'activity',
      ref: a.org,
      recency_year: null,
      text: [a.role ?? '', ...(a.bullets ?? [])].join(' '),
    });
  }
  if (doc.summary && doc.summary.trim()) {
    out.push({ kind: 'summary', ref: 'Summary', recency_year: null, text: doc.summary });
  }
  const listed = [
    ...(doc.skills?.technical ?? []),
    ...(doc.skills?.tools ?? []),
    ...(doc.skills?.soft ?? []),
  ].join(', ');
  if (listed.trim())
    out.push({ kind: 'skills_list', ref: 'Skills', recency_year: null, text: listed });
  return out;
}

/**
 * Deterministic, display-only evidence ledger: for each skill found ANYWHERE in the CV, record
 * where (sources), the best strength (demonstrated > mentioned > listed_only), and recency.
 * NEVER feeds any score. `scan`/`resolveDisplay` injected to keep this pure + testable.
 */
export function buildEvidenceLedger(
  doc: CanonicalCvDocument,
  scan: (text: string) => ScannedSkill[],
  resolveDisplay: (canonical: string) => string,
  nowYear: number,
): EvidenceLedger {
  const byCanonical = new Map<string, EvidenceSource[]>();
  for (const section of sectionsOf(doc, nowYear)) {
    if (!section.text.trim()) continue;
    const seen = new Set<string>(); // dedupe within one section
    for (const hit of scan(section.text)) {
      if (seen.has(hit.canonical_name)) continue;
      seen.add(hit.canonical_name);
      const list = byCanonical.get(hit.canonical_name) ?? [];
      list.push({ kind: section.kind, ref: section.ref, recency_year: section.recency_year });
      byCanonical.set(hit.canonical_name, list);
    }
  }
  const items: EvidenceItem[] = [];
  for (const [canonical, sources] of byCanonical) {
    const strength: EvidenceStrength = sources.some((s) => DEMONSTRATED_KINDS.has(s.kind))
      ? 'demonstrated'
      : sources.some((s) => s.kind === 'summary')
        ? 'mentioned'
        : 'listed_only';
    const years = sources.map((s) => s.recency_year).filter((y): y is number => y != null);
    items.push({
      skill_canonical: canonical,
      display_name: resolveDisplay(canonical),
      sources,
      strength,
      most_recent_year: years.length ? Math.max(...years) : null,
    });
  }
  items.sort(
    (a, b) =>
      STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength] ||
      a.display_name.localeCompare(b.display_name),
  );
  const evidence_gap = items
    .filter((i) => i.strength === 'listed_only')
    .map((i) => i.skill_canonical);
  return { items, evidence_gap };
}
