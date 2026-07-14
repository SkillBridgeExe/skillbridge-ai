import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { GoogleAuth } from 'google-auth-library';

export interface DisplayTranslationInput {
  locale: 'vi' | 'en';
  title?: string;
  description?: string;
  reason?: string;
  summary?: string;
}

export interface DisplayTranslationOutput extends DisplayTranslationInput {}

@Injectable()
export class DisplayTranslationService {
  private readonly cache = new Map<string, DisplayTranslationOutput>();
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-translation'],
  });

  async translateDisplay(input: DisplayTranslationInput): Promise<DisplayTranslationOutput> {
    const key = cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const localOutput = translateLocalDisplay(input);
    if (hasLocalTranslation(input, localOutput)) {
      this.cache.set(key, localOutput);
      return localOutput;
    }

    if (process.env.GOOGLE_TRANSLATE_ENABLED !== 'true') return input;
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    if (!projectId) return input;

    try {
      const fields = ['title', 'description', 'reason', 'summary'] as const;
      const values = fields
        .map((field) => ({ field, value: input[field] }))
        .filter((item): item is { field: (typeof fields)[number]; value: string } =>
          Boolean(item.value),
        );
      if (values.length === 0) return input;

      const client = await this.auth.getClient();
      const response = await client.request<{
        translations?: Array<{ translatedText?: string }>;
      }>({
        url: `https://translation.googleapis.com/v3/projects/${projectId}/locations/global:translateText`,
        method: 'POST',
        data: {
          mimeType: 'text/plain',
          targetLanguageCode: input.locale,
          contents: values.map((item) => item.value),
        },
      });

      const output: DisplayTranslationOutput = { locale: input.locale };
      values.forEach((item, index) => {
        output[item.field] =
          response.data.translations?.[index]?.translatedText?.trim() || item.value;
      });
      this.cache.set(key, output);
      return output;
    } catch {
      return input;
    }
  }
}

function cacheKey(input: DisplayTranslationInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

const EXACT_TITLE_TRANSLATIONS_VI = new Map<string, string>([
  ['React Tutorial for Beginners', 'Học React cơ bản cho người mới'],
  ['React Quick Start', 'Bắt đầu nhanh với React'],
  ['Docker Get Started', 'Bắt đầu với Docker'],
  ['TypeScript Handbook', 'Sổ tay TypeScript'],
  ['JavaScript Guide', 'Hướng dẫn JavaScript'],
  ['The Python Tutorial', 'Hướng dẫn Python'],
]);

const KNOWN_TECH_TERMS = new Set(
  [
    'React',
    'TypeScript',
    'JavaScript',
    'Node.js',
    'Docker',
    'SQL',
    'PostgreSQL',
    'REST API',
    'GraphQL',
    'Git',
    'GitHub',
    'AWS',
    'HTML',
    'CSS',
    'Python',
    'Java',
    'Spring Boot',
    '.NET',
    'C#',
    'LLM',
    'LangChain',
  ].map(normalizeLookup),
);

function translateLocalDisplay(input: DisplayTranslationInput): DisplayTranslationOutput {
  if (input.locale !== 'vi') return input;

  return {
    locale: input.locale,
    title: input.title ? translateTitleVi(input.title) : undefined,
    description: input.description ? translateDescriptionVi(input.description) : undefined,
    reason: input.reason,
    summary: input.summary,
  };
}

function hasLocalTranslation(
  input: DisplayTranslationInput,
  output: DisplayTranslationOutput,
): boolean {
  return (['title', 'description', 'reason', 'summary'] as const).some(
    (field) => Boolean(input[field]) && input[field] !== output[field],
  );
}

function translateTitleVi(title: string): string {
  const cleanTitle = normalizeSpaces(title);
  const exact = EXACT_TITLE_TRANSLATIONS_VI.get(cleanTitle);
  if (exact) return exact;

  const titleWithoutBrackets = normalizeSpaces(cleanTitle.replace(/\s*\[[^\]]+\]\s*/g, ' '));
  const exactWithoutBrackets = EXACT_TITLE_TRANSLATIONS_VI.get(titleWithoutBrackets);
  if (exactWithoutBrackets) return exactWithoutBrackets;

  const beginnerMatch = titleWithoutBrackets.match(/^(.+?)\s+(?:Tutorial|Course)\s+for\s+Beginners$/i);
  if (beginnerMatch) {
    const tech = normalizeTechTerm(beginnerMatch[1]);
    if (tech) return `Học ${tech} cơ bản cho người mới`;
  }

  const fullCourseMatch = titleWithoutBrackets.match(/^(.+?)\s+Full\s+Course$/i);
  if (fullCourseMatch) {
    const tech = normalizeTechTerm(fullCourseMatch[1]);
    if (tech) return `Khóa học ${tech} đầy đủ`;
  }

  const crashCourseMatch = titleWithoutBrackets.match(/^(.+?)\s+Crash\s+Course$/i);
  if (crashCourseMatch) {
    const tech = normalizeTechTerm(crashCourseMatch[1]);
    if (tech) return `Khóa học cấp tốc về ${tech}`;
  }

  const quickStartMatch = titleWithoutBrackets.match(/^(.+?)\s+(?:Quick\s+Start|Get\s+Started)$/i);
  if (quickStartMatch) {
    const tech = normalizeTechTerm(quickStartMatch[1]);
    if (tech) return `Bắt đầu nhanh với ${tech}`;
  }

  const handbookMatch = titleWithoutBrackets.match(/^(.+?)\s+Handbook$/i);
  if (handbookMatch) {
    const tech = normalizeTechTerm(handbookMatch[1]);
    if (tech) return `Sổ tay ${tech}`;
  }

  const guideMatch = titleWithoutBrackets.match(/^(.+?)\s+Guide$/i);
  if (guideMatch) {
    const tech = normalizeTechTerm(guideMatch[1]);
    if (tech) return `Hướng dẫn ${tech}`;
  }

  const introMatch = titleWithoutBrackets.match(/^Introduction\s+to\s+(.+)$/i);
  if (introMatch) {
    const tech = normalizeTechTerm(introMatch[1]);
    if (tech) return `Giới thiệu về ${tech}`;
  }

  return title;
}

function translateDescriptionVi(description: string): string {
  const cleanDescription = normalizeSpaces(description);
  if (
    cleanDescription ===
    'Curated React video with SkillBridge chapter markers for component, props, state, list, and effect remediation.'
  ) {
    return 'Video React được SkillBridge chọn lọc, có mốc chương cho component, props, state, list và effect.';
  }

  const curatedVideoMatch = cleanDescription.match(
    /^Curated\s+(.+?)\s+video\s+with\s+SkillBridge\s+chapter\s+markers\s+for\s+(.+)\.$/i,
  );
  if (curatedVideoMatch) {
    const tech = normalizeTechTerm(curatedVideoMatch[1]);
    if (tech) {
      const topics = normalizeTopicsVi(curatedVideoMatch[2]);
      return `Video ${tech} được SkillBridge chọn lọc, có mốc chương cho ${topics}.`;
    }
  }

  return description;
}

function normalizeTopicsVi(topics: string): string {
  return normalizeSpaces(topics)
    .replace(/\s+remediation\b/gi, '')
    .replace(/,\s+and\s+/i, ' và ')
    .replace(/\s+and\s+/i, ' và ');
}

function normalizeTechTerm(value: string): string | undefined {
  const cleanValue = normalizeSpaces(value);
  return KNOWN_TECH_TERMS.has(normalizeLookup(cleanValue)) ? cleanValue : undefined;
}

function normalizeLookup(value: string): string {
  return normalizeSpaces(value).toLowerCase();
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
