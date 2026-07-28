import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { GoogleAuth } from 'google-auth-library';

export type LearningDisplayField = 'title' | 'description' | 'reason' | 'summary';

export interface LearningDisplayTranslationInput {
  locale: 'vi' | 'en';
  title?: string;
  description?: string;
  reason?: string;
  summary?: string;
}

export type LearningDisplayTranslationOutput = LearningDisplayTranslationInput;
export interface IdentifiedLearningDisplayTranslationInput extends LearningDisplayTranslationInput {
  id: string;
}
export type IdentifiedLearningDisplayTranslationOutput = IdentifiedLearningDisplayTranslationInput;

const FIELDS: readonly LearningDisplayField[] = ['title', 'description', 'reason', 'summary'];
const MAX_CACHE_ENTRIES = 1000;
const MAX_CONCURRENT_ITEMS = 5;
const LOCAL_VI_TITLES = new Map<string, string>([
  ['React Tutorial for Beginners', 'Học React cơ bản cho người mới'],
  ['React Quick Start', 'Bắt đầu nhanh với React'],
  ['Docker Get Started', 'Bắt đầu với Docker'],
  ['TypeScript Handbook', 'Sổ tay TypeScript'],
  ['JavaScript Guide', 'Hướng dẫn JavaScript'],
  ['The Python Tutorial', 'Hướng dẫn Python'],
]);

@Injectable()
export class LearningDisplayTranslationService {
  private readonly cache = new Map<string, LearningDisplayTranslationOutput>();
  private readonly googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-translation'],
  });

  constructor(private readonly config: ConfigService) {}

  async translate(
    input: LearningDisplayTranslationInput,
  ): Promise<LearningDisplayTranslationOutput> {
    if (input.locale === 'en') return { ...input };
    const key = cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) return { ...cached };

    const output: LearningDisplayTranslationOutput = { locale: input.locale };
    for (const field of FIELDS) {
      const source = input[field]?.trim();
      if (!source) continue;
      output[field] =
        localTranslation(field, source) ??
        (await this.translateExternal(source, input.locale)) ??
        source;
    }
    this.setCache(key, output);
    return { ...output };
  }

  async translateMany(
    items: IdentifiedLearningDisplayTranslationInput[],
  ): Promise<IdentifiedLearningDisplayTranslationOutput[]> {
    const output: IdentifiedLearningDisplayTranslationOutput[] = [];
    for (let offset = 0; offset < items.length; offset += MAX_CONCURRENT_ITEMS) {
      const chunk = items.slice(offset, offset + MAX_CONCURRENT_ITEMS);
      output.push(
        ...(await Promise.all(
          chunk.map(async ({ id, ...item }) => ({
            id,
            ...(await this.translate(item)),
          })),
        )),
      );
    }
    return output;
  }

  private async translateExternal(text: string, locale: 'vi' | 'en'): Promise<string | undefined> {
    const libre = await this.translateWithLibre(text, locale);
    if (libre && libre !== text) return libre;
    return this.translateWithGoogle(text, locale);
  }

  private async translateWithLibre(text: string, locale: 'vi' | 'en'): Promise<string | undefined> {
    const baseUrl = this.config.get<string>('learning.translation.libreUrl')?.trim();
    if (!baseUrl) return undefined;
    const timeoutMs = this.config.get<number>('learning.translation.timeoutMs') ?? 5000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL('translate', normalizeBaseUrl(baseUrl)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          source: 'en',
          target: locale,
          format: 'text',
          api_key: this.config.get<string>('learning.translation.libreApiKey') || undefined,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { translatedText?: unknown };
      return typeof data.translatedText === 'string' && data.translatedText.trim()
        ? data.translatedText.trim()
        : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async translateWithGoogle(
    text: string,
    locale: 'vi' | 'en',
  ): Promise<string | undefined> {
    if (!this.config.get<boolean>('learning.translation.googleEnabled')) return undefined;
    const projectId = this.config.get<string>('learning.translation.googleProjectId');
    if (!projectId) return undefined;
    const timeoutMs = this.config.get<number>('learning.translation.timeoutMs') ?? 5000;
    try {
      const client = await this.googleAuth.getClient();
      const response = await client.request<{
        translations?: Array<{ translatedText?: string }>;
      }>({
        url: `https://translation.googleapis.com/v3/projects/${projectId}/locations/global:translateText`,
        method: 'POST',
        timeout: timeoutMs,
        data: {
          mimeType: 'text/plain',
          targetLanguageCode: locale,
          contents: [text],
        },
      });
      const translated = response.data.translations?.[0]?.translatedText?.trim();
      return translated || undefined;
    } catch {
      return undefined;
    }
  }

  private setCache(key: string, value: LearningDisplayTranslationOutput): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { ...value });
  }
}

function localTranslation(field: LearningDisplayField, source: string): string | undefined {
  if (field !== 'title') return undefined;
  const exact = LOCAL_VI_TITLES.get(source);
  if (exact) return exact;
  const beginner = source.match(/^(.+?)\s+(?:Tutorial|Course)\s+for\s+Beginners$/i);
  return beginner ? `Học ${beginner[1].trim()} cơ bản cho người mới` : undefined;
}

function cacheKey(input: LearningDisplayTranslationInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
