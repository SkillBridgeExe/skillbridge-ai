import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { TemplateRenderer } from './template-renderer';
import { ERROR_CODES } from '../../common/constants/error-codes';

export interface PromptTemplate {
  code: string;
  version: number;
  filename: string;
  /** The raw markdown body. */
  body: string;
  /** Frontmatter-style metadata if present at the top of the file. */
  meta: Record<string, string>;
}

/**
 * Loads all prompt templates from the `prompts/` folder on startup.
 *
 * Filename convention: `<code>_v<version>.md` (e.g. `cv_review_v1.md`).
 */
const REQUIRED_TEMPLATES = [
  'cv_parse_v1',
  'cv_review_v1',
  'cv_rewrite_v1',
  'cv_jd_match_v1',
  'cv_jd_match_v2',
  'answer_insight_v1',
  'interview_coaching_v1',
  'interview_plan_v1',
  'interview_scoring_v1',
  'interview_technical_v1',
  'interview_screening_v1',
  'interview_ask_v1',
  'interview_assess_v1',
  'interview_answer_v1',
  'interview_realtime_voice_v1',
  'interview_realtime_hybrid_v1',
  'interview_tts_v1',
  'interview_transcription_vi_v1',
  'interview_transcription_en_v1',
  'learning_chat_v1',
  'resource_curation_v1',
  'roadmap_v1',
  'roadmap_v2',
  'trends_insight_v1',
];

@Injectable()
export class PromptsService implements OnModuleInit {
  private readonly logger = new Logger(PromptsService.name);
  private readonly templates = new Map<string, PromptTemplate>();
  private readonly promptDir = path.resolve(process.cwd(), 'prompts');

  constructor(private readonly renderer: TemplateRenderer) {}

  async onModuleInit(): Promise<void> {
    try {
      const files = await fs.readdir(this.promptDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const match = file.match(/^([a-z0-9_-]+)_v(\d+)\.md$/i);
        if (!match) {
          this.logger.warn(`Skipping prompt file with invalid name: ${file}`);
          continue;
        }
        const code = match[1];
        const version = parseInt(match[2], 10);
        const fullPath = path.join(this.promptDir, file);
        const raw = await fs.readFile(fullPath, 'utf8');
        const { body, meta } = this.parseFrontmatter(raw);
        const key = `${code}_v${version}`;
        this.templates.set(key, { code, version, filename: file, body, meta });
      }
      this.logger.log(`Loaded ${this.templates.size} prompt templates.`);
    } catch (err) {
      this.logger.error(`Failed to load prompts/: ${(err as Error).message}`);
      throw err;
    }

    const missing: string[] = [];
    for (const required of REQUIRED_TEMPLATES) {
      if (!this.templates.has(required)) {
        missing.push(required);
      }
    }
    if (missing.length > 0) {
      const errorMsg = `Required prompt templates are missing from prompts/ folder: ${missing.join(', ')}`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /** Lookup by combined code (e.g. `cv_review_v1`). */
  get(combinedCode: string): PromptTemplate {
    const template = this.templates.get(combinedCode);
    if (!template) {
      throw new NotFoundException({
        code: ERROR_CODES.PROMPT_TEMPLATE_NOT_FOUND,
        message: `Prompt template not found: ${combinedCode}`,
      });
    }
    return template;
  }

  /** Render a template with placeholders. */
  render(combinedCode: string, vars: Record<string, unknown>): string {
    const template = this.get(combinedCode);
    return this.renderer.render(template.body, vars);
  }

  list(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }

  private parseFrontmatter(raw: string): { body: string; meta: Record<string, string> } {
    const meta: Record<string, string> = {};
    if (!raw.startsWith('---\n')) {
      return { body: raw, meta };
    }
    const end = raw.indexOf('\n---\n', 4);
    if (end === -1) {
      return { body: raw, meta };
    }
    const front = raw.slice(4, end);
    for (const line of front.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      meta[key] = value;
    }
    return { body: raw.slice(end + 5), meta };
  }
}
