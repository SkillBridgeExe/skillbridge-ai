/**
 * CanonicalCvDocument — the central data model for the entire CV feature.
 *
 * This is the HUB. Four flows read/write the exact same structure so nothing
 * has to re-parse or re-shape:
 *
 *   parse  (uploaded CV text)        ──► CanonicalCvDocument
 *   intake (no-CV guided builder)    ──► CanonicalCvDocument
 *   score  (CV diagnosis)            ──◄ CanonicalCvDocument
 *   rewrite(improve content)         ──► CanonicalCvDocument (improved)
 *   render (Harvard PNG/PDF)         ──◄ CanonicalCvDocument
 *
 * Design notes:
 *  - All fields optional/nullable-friendly: a fresh student's CV may have no
 *    `experience` but plenty of `projects` + `activities`. The renderer/scorer
 *    must tolerate empty sections gracefully.
 *  - Dates are free-text strings ("09/2023", "2023", "Present", "Hiện tại") —
 *    we do NOT force ISO. CVs use inconsistent formats; the renderer displays
 *    them as-is and the ATS checker validates presence, not format.
 *  - `language` is auto-detected during parse/intake and drives feedback +
 *    Harvard output language. ISO 639-1 where possible ("vi", "en", "ja"),
 *    falls back to a best-effort label.
 *  - Skill strings here are RAW (as written by the candidate). Normalization to
 *    the taxonomy is done separately by SkillNormalizerService when needed.
 */

/** A single contact link (LinkedIn, GitHub, portfolio, etc.). */
export interface CvLink {
  /** Display label, e.g. "GitHub", "Portfolio", "LinkedIn". */
  label: string;
  url: string;
}

export interface CvContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** City / country, e.g. "Hồ Chí Minh, Việt Nam". */
  location: string | null;
  links: CvLink[];
}

export interface CvEducationEntry {
  school: string;
  /** e.g. "Cử nhân", "Bachelor", "Kỹ sư". */
  degree: string | null;
  /** Field of study, e.g. "Kỹ thuật phần mềm". */
  field: string | null;
  start: string | null;
  end: string | null;
  /** GPA as written, e.g. "3.4/4.0", "8.2/10". Free-text. */
  gpa: string | null;
  /** Honors, relevant coursework, thesis — each a short line. */
  highlights: string[];
}

export interface CvExperienceEntry {
  org: string;
  role: string | null;
  start: string | null;
  end: string | null;
  location: string | null;
  /** Achievement bullets. Ideally action-verb + quantified outcome. */
  bullets: string[];
}

export interface CvProjectEntry {
  name: string;
  /** e.g. "Solo", "Team of 4", "Lead". */
  role: string | null;
  /** Technologies/tools used (raw strings). */
  tech: string[];
  bullets: string[];
  /** Demo/repo link if any. */
  link: string | null;
}

export interface CvSkills {
  /** Hard/technical skills, e.g. "React", "PostgreSQL". */
  technical: string[];
  /** Soft skills, e.g. "Teamwork", "Communication". */
  soft: string[];
  /** Spoken languages, e.g. "English (IELTS 7.0)", "Tiếng Nhật N3". */
  languages: string[];
  /** Tools/platforms, e.g. "Figma", "Docker", "Jira". */
  tools: string[];
}

export interface CvCertification {
  name: string;
  issuer: string | null;
  date: string | null;
}

/** Clubs, volunteering, competitions — high-signal for students with thin work history. */
export interface CvActivity {
  org: string;
  role: string | null;
  bullets: string[];
}

export interface CanonicalCvDocument {
  /**
   * Detected language of the CV content. ISO 639-1 when recognizable
   * ("vi", "en", "ja", ...). Drives feedback + Harvard output language.
   */
  language: string;
  contact: CvContact;
  /** Professional summary / objective. Empty string if none. */
  summary: string;
  education: CvEducationEntry[];
  experience: CvExperienceEntry[];
  projects: CvProjectEntry[];
  skills: CvSkills;
  certifications: CvCertification[];
  activities: CvActivity[];
}

/**
 * Returns an empty CanonicalCvDocument with all sections initialized.
 * Useful as a safe default for the no-CV intake wizard and as a merge base
 * when a parse returns partial data.
 */
export function emptyCanonicalCv(language = 'en'): CanonicalCvDocument {
  return {
    language,
    contact: { name: null, email: null, phone: null, location: null, links: [] },
    summary: '',
    education: [],
    experience: [],
    projects: [],
    skills: { technical: [], soft: [], languages: [], tools: [] },
    certifications: [],
    activities: [],
  };
}
