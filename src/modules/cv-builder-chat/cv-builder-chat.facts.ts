/**
 * Deterministic fact source for the CV-builder chat companion: turns the open CV draft +
 * the field the user is editing into the facts the LLM is licensed to phrase. No LLM here —
 * reuses the shipped pure gap analyzers (cv-assistant.ts) so the two assistants stay consistent.
 *
 * `field_path` is an OPAQUE, FE-owned identity (ResumeDocumentV1 world) — we only echo it back
 * verbatim, never parse/mint it against CanonicalCvDocument.
 */
import { analyzeBulletGaps, analyzeSummaryGaps } from '../cv-assistant/cv-assistant';
import type { CanonicalCvDocument } from '../../common/types/canonical-cv';
import type { CvBuilderDiagnosisBlock } from './cv-builder-diagnosis';

export interface CvBuilderChatFacts {
  target_role: string | null;
  cv_language: 'vi' | 'en';
  sections: Array<{ section: string; present: boolean; item_count: number }>;
  focus: {
    section: 'projects' | 'experience' | 'summary';
    field_path: string;
    current_text: string;
    gaps: string[];
  } | null;
  /** Latest CV-scan findings, ALREADY digit-stripped — discussed in words only, PROSE-license only
   *  (the two-corpus gate keeps it out of the edit corpus). Null when this CV has no scan review. */
  diagnosis: CvBuilderDiagnosisBlock | null;
}

const SECTION_ORDER = [
  'summary',
  'experience',
  'projects',
  'education',
  'skills',
  'certifications',
  'activities',
] as const;

const FOCUSABLE_SECTIONS = new Set(['projects', 'experience', 'summary']);

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSections(
  doc: CanonicalCvDocument,
): Array<{ section: string; present: boolean; item_count: number }> {
  return SECTION_ORDER.map((section) => {
    if (section === 'summary') {
      const present = doc.summary.trim().length > 0;
      return { section, present, item_count: present ? 1 : 0 };
    }
    if (section === 'skills') {
      const { technical, soft, languages, tools } = doc.skills;
      const item_count = technical.length + soft.length + languages.length + tools.length;
      return { section, present: item_count > 0, item_count };
    }
    const arr = doc[section];
    return { section, present: arr.length > 0, item_count: arr.length };
  });
}

export function buildCvBuilderFacts(
  doc: CanonicalCvDocument,
  focusedField: { field_path: string; current_value: string } | null,
  targetRole: string | null,
  diagnosis: CvBuilderDiagnosisBlock | null = null,
): CvBuilderChatFacts {
  const cv_language: 'vi' | 'en' = doc.language?.toLowerCase().startsWith('vi') ? 'vi' : 'en';
  const sections = buildSections(doc);

  let focus: CvBuilderChatFacts['focus'] = null;
  if (focusedField) {
    const withoutPrefix = focusedField.field_path.replace(/^cvbuilder:/, '');
    const section = withoutPrefix.split(/[[.]/, 1)[0];
    if (FOCUSABLE_SECTIONS.has(section)) {
      const current_text = stripHtml(focusedField.current_value);
      const gaps: string[] =
        section === 'summary'
          ? analyzeSummaryGaps(current_text, cv_language)
          : analyzeBulletGaps(current_text, cv_language);
      focus = {
        section: section as 'projects' | 'experience' | 'summary',
        field_path: focusedField.field_path,
        current_text,
        gaps,
      };
    }
  }

  return { target_role: targetRole, cv_language, sections, focus, diagnosis };
}
