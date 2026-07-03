import { CanonicalCvDocument } from '../types/canonical-cv';
import { ScannedSkill } from './skill-text-scanner.service';

export type EvidenceKind = 'experience' | 'project' | 'activity' | 'summary' | 'skills_list';
export type EvidenceStrength = 'demonstrated' | 'mentioned' | 'listed_only';

export interface EvidenceSource {
  kind: EvidenceKind;
  ref: string;
  recency_year: number | null;
  /** The real bullet/sentence that matched (trimmed ≤200 chars); null for a bare listing (Skills
   *  section, or a hit found only in a non-sentence unit like a role title / project tech line).
   *  PII note: this is raw CV text — it flows through cv-review.service.ts's `redactForTrace`
   *  (JSON-wide email/phone masking) on persist same as every other parsed field; a masked quote
   *  in the persisted trace copy is accepted. */
  quote: string | null;
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

const QUOTE_MAX_CHARS = 200;
const trimQuote = (s: string): string => s.trim().slice(0, QUOTE_MAX_CHARS);

/** A single scannable piece of a section. `quotable`: whether a hit found HERE cites this unit's
 *  own text as the quote (a real bullet/sentence) vs. `null` (a bare listing — role title, project
 *  tech line, Skills section: not a proof sentence, just a name). */
interface ScanUnit {
  text: string;
  quotable: boolean;
}

interface Section {
  kind: EvidenceKind;
  ref: string;
  recency_year: number | null;
  units: ScanUnit[];
}

const bullet = (text: string): ScanUnit => ({ text, quotable: true });
const label = (text: string): ScanUnit => ({ text, quotable: false });

/** Split a paragraph into sentences (kept WITH their terminal punctuation) for summary quoting. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sectionsOf(doc: CanonicalCvDocument, nowYear: number): Section[] {
  const out: Section[] = [];
  for (const e of doc.experience ?? []) {
    out.push({
      kind: 'experience',
      ref: e.role ? `${e.org} — ${e.role}` : e.org,
      recency_year: recencyYear(e.end, nowYear),
      // Scan per-bullet (not the old joined-section text) so a hit can cite the REAL bullet as its
      // quote. Role title stays a scannable unit (detection unchanged) but isn't a proof sentence.
      units: [...(e.role ? [label(e.role)] : []), ...(e.bullets ?? []).map(bullet)],
    });
  }
  for (const p of doc.projects ?? []) {
    const techText = (p.tech ?? []).join(', ');
    out.push({
      kind: 'project',
      ref: p.name,
      recency_year: null,
      units: [
        label(p.name),
        ...(techText ? [label(techText)] : []),
        ...(p.bullets ?? []).map(bullet),
      ],
    });
  }
  for (const a of doc.activities ?? []) {
    out.push({
      kind: 'activity',
      ref: a.org,
      recency_year: null,
      units: [...(a.role ? [label(a.role)] : []), ...(a.bullets ?? []).map(bullet)],
    });
  }
  if (doc.summary && doc.summary.trim()) {
    // Scan the whole paragraph at once (unchanged detection); quote is derived per-hit below by
    // finding the containing sentence, not the whole summary.
    out.push({ kind: 'summary', ref: 'Summary', recency_year: null, units: [bullet(doc.summary)] });
  }
  const listed = [
    ...(doc.skills?.technical ?? []),
    ...(doc.skills?.tools ?? []),
    ...(doc.skills?.soft ?? []),
  ].join(', ');
  if (listed.trim())
    out.push({ kind: 'skills_list', ref: 'Skills', recency_year: null, units: [label(listed)] });
  return out;
}

/** Summary's unit is the whole paragraph (to keep scan() detection identical to before) — but the
 *  quote should be the SENTENCE that contains the match, not the whole paragraph. */
function summaryQuote(paragraph: string, matchedText: string): string | null {
  const needle = matchedText.toLowerCase();
  const found = sentencesOf(paragraph).find((s) => s.toLowerCase().includes(needle));
  return trimQuote(found ?? paragraph);
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
    const seen = new Set<string>(); // dedupe within one section (same ref) across its units
    // Perf: scanning per-bullet instead of the old joined-section text raises scan() calls from
    // ~4/CV to ~30-60/CV (one per bullet/unit). Accepted — SkillTextScannerService's matchers are
    // precompiled regex (skill-text-scanner.service.ts:34), so each call is cheap.
    // Quotable units (bullets/summary) scan first: Array.prototype.sort is a stable sort, so this
    // only moves label units (role title, project name, tech line) after them within the section.
    // A label matching a skill already claimed by a bullet is then skipped by the seen-dedup below
    // instead of stealing the slot with a null quote.
    const orderedUnits = [...section.units].sort((a, b) => Number(b.quotable) - Number(a.quotable));
    for (const unit of orderedUnits) {
      if (!unit.text.trim()) continue;
      for (const hit of scan(unit.text)) {
        if (seen.has(hit.canonical_name)) continue;
        seen.add(hit.canonical_name);
        const list = byCanonical.get(hit.canonical_name) ?? [];
        const quote = !unit.quotable
          ? null
          : section.kind === 'summary'
            ? summaryQuote(unit.text, hit.matched_text)
            : trimQuote(unit.text);
        list.push({
          kind: section.kind,
          ref: section.ref,
          recency_year: section.recency_year,
          quote,
        });
        byCanonical.set(hit.canonical_name, list);
      }
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
