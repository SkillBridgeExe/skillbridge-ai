import { CanonicalCvDocument } from '../types/canonical-cv';

/**
 * Render a CanonicalCvDocument to plain text — the parsed_text equivalent for BUILT drafts.
 *
 * Platform context: `rerunReview()` in cvs.service.ts requires `parsed_text`, but BUILT drafts
 * only carry `parsed_json` (no uploaded file text). Calling this function and passing the result
 * as `parsed_text` lets the platform wire Analyze-gap for builder-originated CVs in one line.
 *
 * Design:
 *  - Sections with no content are skipped entirely (no dangling headers).
 *  - Deterministic: same doc → same output, no randomness, no LLM.
 *  - Empty doc → empty string ''.
 */
export function documentToPlainText(doc: CanonicalCvDocument): string {
  const lines: string[] = [];

  const add = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  };

  // ── Contact ──────────────────────────────────────────────────────────────
  if (doc.contact.name) add(doc.contact.name);
  const contactParts: string[] = [];
  if (doc.contact.email) contactParts.push(doc.contact.email);
  if (doc.contact.phone) contactParts.push(doc.contact.phone);
  if (doc.contact.location) contactParts.push(doc.contact.location);
  if (contactParts.length) add(contactParts.join(' | '));

  for (const link of doc.contact.links ?? []) {
    if (link.label || link.url) add(`${link.label}: ${link.url}`.trim());
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  if (doc.summary?.trim()) add(doc.summary.trim());

  // ── Education ────────────────────────────────────────────────────────────
  if (doc.education?.length) {
    for (const edu of doc.education) {
      const header = [edu.school, edu.degree, edu.field].filter(Boolean).join(', ');
      add(header);
      const dateLine = [edu.start, edu.end].filter(Boolean).join(' – ');
      if (dateLine) add(dateLine);
      if (edu.gpa) add(`GPA: ${edu.gpa}`);
      for (const h of edu.highlights ?? []) add(h);
    }
  }

  // ── Experience ───────────────────────────────────────────────────────────
  if (doc.experience?.length) {
    for (const exp of doc.experience) {
      const header = [exp.org, exp.role].filter(Boolean).join(' — ');
      add(header);
      const dateLine = [[exp.start, exp.end].filter(Boolean).join(' – '), exp.location]
        .filter(Boolean)
        .join(', ');
      if (dateLine) add(dateLine);
      for (const b of exp.bullets ?? []) add(b);
    }
  }

  // ── Projects ─────────────────────────────────────────────────────────────
  if (doc.projects?.length) {
    for (const proj of doc.projects) {
      const nameRole = proj.role ? `${proj.name} (${proj.role})` : proj.name;
      add(nameRole);
      if (proj.tech?.length) add(proj.tech.join(', '));
      for (const b of proj.bullets ?? []) add(b);
      if (proj.link) add(proj.link);
    }
  }

  // ── Skills ───────────────────────────────────────────────────────────────
  const s = doc.skills;
  if (s) {
    if (s.technical?.length) add(`Technical: ${s.technical.join(', ')}`);
    if (s.soft?.length) add(`Soft skills: ${s.soft.join(', ')}`);
    if (s.languages?.length) add(`Languages: ${s.languages.join(', ')}`);
    if (s.tools?.length) add(`Tools: ${s.tools.join(', ')}`);
  }

  // ── Certifications ───────────────────────────────────────────────────────
  if (doc.certifications?.length) {
    for (const cert of doc.certifications) {
      const parts = [cert.name, cert.issuer].filter(Boolean).join(' — ');
      add(cert.date ? `${parts} (${cert.date})` : parts);
    }
  }

  // ── Activities ───────────────────────────────────────────────────────────
  if (doc.activities?.length) {
    for (const act of doc.activities) {
      const header = [act.org, act.role].filter(Boolean).join(' — ');
      add(header);
      for (const b of act.bullets ?? []) add(b);
    }
  }

  return lines.join('\n');
}
