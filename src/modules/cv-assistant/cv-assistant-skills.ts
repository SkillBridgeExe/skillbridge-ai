/**
 * CV Builder Assistant — Skills section completeness nudge (PURE, deterministic, no LLM).
 *
 * This is NOT a rewrite: a skills list is data, not prose. The assistant only POINTS OUT what is thin or
 * missing and asks the user to add it — it NEVER invents a skill, tool, or language (anti-fabrication).
 * Returns an empty list when the section already looks complete.
 */
import { Language } from './cv-assistant';

export interface SkillsSection {
  technical?: string[];
  soft?: string[];
  languages?: string[];
  tools?: string[];
}

export type SkillsNudgeCode = 'too_few_technical' | 'no_tools' | 'no_languages';

export interface SkillsNudge {
  code: SkillsNudgeCode;
  /** user-facing, bilingual; suggests CATEGORIES/examples only — never writes a skill into the CV. */
  message: string;
}

/** a healthy technical-skills list has at least this many entries. */
export const MIN_TECHNICAL = 4;

const MESSAGES: Record<Language, Record<SkillsNudgeCode, (n: number) => string>> = {
  en: {
    too_few_technical: (n) =>
      `You have ${n} technical skill${n === 1 ? '' : 's'} — add a few more that match your target role.`,
    no_tools: () => 'List the tools you actually use (e.g. Git, Docker, Figma).',
    no_languages: () => 'Add the languages you speak (e.g. English — IELTS / TOEIC).',
  },
  vi: {
    too_few_technical: (n) =>
      `Bạn mới có ${n} kỹ năng kỹ thuật — thêm vài kỹ năng phù hợp với vị trí mục tiêu.`,
    no_tools: () => 'Liệt kê công cụ bạn thực sự dùng (vd Git, Docker, Figma).',
    no_languages: () => 'Thêm ngoại ngữ bạn biết (vd Tiếng Anh — IELTS / TOEIC).',
  },
};

/** Deterministically flag thin/missing parts of the skills section. Empty list ⇒ already complete. */
export function analyzeSkillsSection(skills: SkillsSection, language: Language): SkillsNudge[] {
  const technical = skills.technical ?? [];
  const tools = skills.tools ?? [];
  const languages = skills.languages ?? [];
  const nudges: SkillsNudge[] = [];

  if (technical.length < MIN_TECHNICAL) {
    nudges.push({
      code: 'too_few_technical',
      message: MESSAGES[language].too_few_technical(technical.length),
    });
  }
  if (tools.length === 0) {
    nudges.push({ code: 'no_tools', message: MESSAGES[language].no_tools(0) });
  }
  if (languages.length === 0) {
    nudges.push({ code: 'no_languages', message: MESSAGES[language].no_languages(0) });
  }
  return nudges;
}
