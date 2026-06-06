/**
 * R1b — evaluate-section contract (R1b-cv-builder-spec.md §6, §9.2-9.3).
 * Content shapes mirror the FE builder store (useCvBuilderStore) field-for-field so the
 * FE posts its section state verbatim — no client-side remapping.
 */

export type BuilderSection =
  | 'basic'
  | 'summary'
  | 'experience'
  | 'education'
  | 'projects'
  | 'skills'
  | 'certifications';

export interface BasicContent {
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
}

export interface SummaryContent {
  summary?: string;
}

export interface ExperienceEntry {
  position?: string;
  company?: string;
  startDate?: string;
  endDate?: string;
  isCurrent?: boolean;
  description?: string;
  achievements?: string;
}

export interface EducationEntry {
  school?: string;
  major?: string;
  degree?: string;
  startYear?: string;
  endYear?: string;
  gpa?: string;
  achievements?: string;
}

export interface ProjectEntry {
  name?: string;
  role?: string;
  tools?: string;
  description?: string;
  contribution?: string;
  result?: string;
}

export interface SkillsContent {
  technicalSkills?: string[];
  softSkills?: string[];
  tools?: string[];
  languages?: string[];
}

export interface CertificationEntry {
  name?: string;
  organization?: string;
  issueDate?: string;
  expiryDate?: string;
  link?: string;
}

export type SectionContent =
  | BasicContent
  | SummaryContent
  | { entries: ExperienceEntry[] }
  | { entries: EducationEntry[] }
  | { entries: ProjectEntry[] }
  | SkillsContent
  | { entries: CertificationEntry[] };

export class EvaluateSectionRequestDto {
  section!: BuilderSection;
  /** One of the 8 IT role codes — sharpens "missing" hints; optional. */
  role_code?: string;
  language?: 'vi' | 'en';
  content!: SectionContent;
}

export interface ChecklistItem {
  /** Stable id, e.g. 'exp_verb_first' — FE keys ✅/❌ rows off this. */
  id: string;
  /** Human label in the request language. */
  criterion: string;
  pass: boolean;
}

export class EvaluateSectionResponseDto {
  /** round(passed/total × 100); 0 when the section is empty. */
  score!: number;
  /** ≥80 'Rất tốt' · 1-79 'Cần cải thiện' · 0/empty 'Chưa có thông tin' (vi) — localized. */
  label!: string;
  checklist!: ChecklistItem[];
  /** "Cần bổ sung" — actionable hints derived from FAILED criteria (+ role rubric). */
  missing!: string[];
}
