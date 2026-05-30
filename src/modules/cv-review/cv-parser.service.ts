import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import {
  CanonicalCvDocument,
  CvActivity,
  CvCertification,
  CvEducationEntry,
  CvExperienceEntry,
  CvLink,
  CvProjectEntry,
  emptyCanonicalCv,
} from '../../common/types/canonical-cv';

export interface CvParseResult {
  document: CanonicalCvDocument;
  tokenUsage: number;
  modelCode: string;
  latencyMs: number;
  promptTemplateVersion: number;
}

/**
 * Stage 1 of the CV pipeline: raw extracted CV text → CanonicalCvDocument.
 *
 * This is the FOUNDATION for everything downstream:
 *   - CvReviewService scores the structured document (more reliable than raw text)
 *   - CvRewriteService improves it
 *   - HarvardTemplate / render consumes it
 *
 * The LLM does extraction only (faithful, no embellishment). This service then
 * defensively coerces the LLM JSON into a guaranteed-valid CanonicalCvDocument
 * so downstream code never has to null-check missing sections.
 *
 * Tracing is intentionally NOT done here — the orchestrating service
 * (CvReviewService / CvBuilderService) owns the ai_request lifecycle and can
 * record this call's token usage via the returned `tokenUsage`.
 */
@Injectable()
export class CvParserService {
  private readonly logger = new Logger(CvParserService.name);

  private readonly DEFAULT_PROMPT_CODE = 'cv_parse_v1';

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  async parse(cvText: string, opts: { promptCode?: string } = {}): Promise<CvParseResult> {
    const code = opts.promptCode ?? this.DEFAULT_PROMPT_CODE;
    const template = this.prompts.get(code);
    const userPrompt = this.prompts.render(code, { cv_text: cvText });

    const llmResult = await this.llm.complete(
      [
        { role: 'system', content: template.meta.system ?? '' },
        { role: 'user', content: userPrompt },
      ],
      // Parsing is a deterministic extraction task — keep temperature minimal.
      { jsonMode: true, temperature: 0.1, maxOutputTokens: 3000 },
    );

    const document = this.coerce(llmResult.parsedJson);

    return {
      document,
      tokenUsage: llmResult.tokenUsage.totalTokens,
      modelCode: llmResult.modelCode,
      latencyMs: llmResult.latencyMs,
      promptTemplateVersion: template.version,
    };
  }

  /**
   * Defensively map arbitrary LLM JSON to a valid CanonicalCvDocument.
   * Missing/wrong-typed fields fall back to safe empties — downstream never
   * has to guard against a missing section.
   */
  coerce(raw: unknown): CanonicalCvDocument {
    const base = emptyCanonicalCv();
    if (!raw || typeof raw !== 'object') {
      this.logger.warn('cv_parse LLM output was not an object; returning empty document.');
      return base;
    }
    const o = raw as Record<string, unknown>;
    const contact = this.asObj(o.contact);

    return {
      language: this.asStr(o.language) || 'en',
      contact: {
        name: this.asStrOrNull(contact.name),
        email: this.asStrOrNull(contact.email),
        phone: this.asStrOrNull(contact.phone),
        location: this.asStrOrNull(contact.location),
        links: this.asArray(contact.links)
          .map((l) => this.coerceLink(l))
          .filter((l): l is CvLink => l !== null),
      },
      summary: this.asStr(o.summary),
      education: this.asArray(o.education).map((e) => this.coerceEducation(e)),
      experience: this.asArray(o.experience).map((e) => this.coerceExperience(e)),
      projects: this.asArray(o.projects).map((p) => this.coerceProject(p)),
      skills: this.coerceSkills(o.skills),
      certifications: this.asArray(o.certifications).map((c) => this.coerceCert(c)),
      activities: this.asArray(o.activities).map((a) => this.coerceActivity(a)),
    };
  }

  // ─── Section coercers ────────────────────────────────────────────────────

  private coerceLink(v: unknown): CvLink | null {
    const o = this.asObj(v);
    const url = this.asStr(o.url);
    if (!url) return null;
    return { label: this.asStr(o.label) || 'Link', url };
  }

  private coerceEducation(v: unknown): CvEducationEntry {
    const o = this.asObj(v);
    return {
      school: this.asStr(o.school),
      degree: this.asStrOrNull(o.degree),
      field: this.asStrOrNull(o.field),
      start: this.asStrOrNull(o.start),
      end: this.asStrOrNull(o.end),
      gpa: this.asStrOrNull(o.gpa),
      highlights: this.asStringArray(o.highlights),
    };
  }

  private coerceExperience(v: unknown): CvExperienceEntry {
    const o = this.asObj(v);
    return {
      org: this.asStr(o.org),
      role: this.asStrOrNull(o.role),
      start: this.asStrOrNull(o.start),
      end: this.asStrOrNull(o.end),
      location: this.asStrOrNull(o.location),
      bullets: this.asStringArray(o.bullets),
    };
  }

  private coerceProject(v: unknown): CvProjectEntry {
    const o = this.asObj(v);
    return {
      name: this.asStr(o.name),
      role: this.asStrOrNull(o.role),
      tech: this.asStringArray(o.tech),
      bullets: this.asStringArray(o.bullets),
      link: this.asStrOrNull(o.link),
    };
  }

  private coerceSkills(v: unknown): CanonicalCvDocument['skills'] {
    const o = this.asObj(v);
    return {
      technical: this.asStringArray(o.technical),
      soft: this.asStringArray(o.soft),
      languages: this.asStringArray(o.languages),
      tools: this.asStringArray(o.tools),
    };
  }

  private coerceCert(v: unknown): CvCertification {
    const o = this.asObj(v);
    return {
      name: this.asStr(o.name),
      issuer: this.asStrOrNull(o.issuer),
      date: this.asStrOrNull(o.date),
    };
  }

  private coerceActivity(v: unknown): CvActivity {
    const o = this.asObj(v);
    return {
      org: this.asStr(o.org),
      role: this.asStrOrNull(o.role),
      bullets: this.asStringArray(o.bullets),
    };
  }

  // ─── Primitive helpers ───────────────────────────────────────────────────

  private asObj(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }

  private asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }

  private asStr(v: unknown): string {
    return typeof v === 'string' ? v : '';
  }

  private asStrOrNull(v: unknown): string | null {
    return typeof v === 'string' && v.trim().length > 0 ? v : null;
  }

  private asStringArray(v: unknown): string[] {
    return this.asArray(v).filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  }
}
