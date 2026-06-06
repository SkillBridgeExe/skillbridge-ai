/**
 * R1b — evaluate-section contract (R1b-cv-builder-spec.md §6, §9.2-9.3).
 * Entry shapes mirror the FE builder store (useCvBuilderStore) field-for-field so the FE
 * posts its section state verbatim — no client-side remapping.
 *
 * The Request DTOs carry class-validator decorators because main.ts runs a GLOBAL
 * ValidationPipe with whitelist+forbidNonWhitelisted — an undecorated DTO would make every
 * incoming property "non-whitelisted" and 400 the request. `content` is validated only as
 * an object (@IsObject): its nested union is NOT recursively whitelisted, so the FE's nested
 * fields pass through intact for the service's defensive per-field reads.
 */
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export type BuilderSection =
  | 'basic'
  | 'summary'
  | 'experience'
  | 'education'
  | 'projects'
  | 'skills'
  | 'certifications';

export const BUILDER_SECTIONS: BuilderSection[] = [
  'basic',
  'summary',
  'experience',
  'education',
  'projects',
  'skills',
  'certifications',
];

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

/** Mirrors FE store WorkExperience (no isCurrent field on the FE — ongoing = blank endDate). */
export interface ExperienceEntry {
  position?: string;
  company?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  responsibilities?: string;
  achievements?: string;
}

/** Mirrors FE store Education. */
export interface EducationEntry {
  school?: string;
  major?: string;
  degree?: string;
  startYear?: string;
  endYear?: string;
  gpa?: string;
  coursework?: string;
  achievements?: string;
}

/** Mirrors FE store Project. */
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

/** Mirrors FE store Certification (uses credentialUrl, no expiryDate). */
export interface CertificationEntry {
  name?: string;
  organization?: string;
  issueDate?: string;
  credentialUrl?: string;
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
  @IsIn(BUILDER_SECTIONS)
  section!: BuilderSection;

  /** One of the 8 IT role codes — sharpens "missing" hints; optional. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  role_code?: string;

  @IsOptional()
  @IsIn(['vi', 'en'])
  language?: 'vi' | 'en';

  @IsObject()
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
