import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import {
  CvReviewExtracted,
  CvReviewLlmDimensions,
  CvReviewRationale,
  CvReviewSection,
} from './dto/cv-review-response.dto';

/**
 * The shape we expect FROM the LLM. The CvReviewService then merges this with
 * the AtsRuleCheckerService output to produce the final CvReviewParsedResponse.
 */
export interface CvReviewLlmRawOutput {
  scores: CvReviewLlmDimensions;
  llm_total: number;
  rationale: CvReviewRationale;
  sections: CvReviewSection[];
  ats_extracted: CvReviewExtracted;
}

/**
 * Validates LLM JSON output matches the new rubric-based schema:
 *   { scores: {action_verbs, skills_relevance, experience, education},
 *     llm_total, rationale, sections, ats_extracted }
 *
 * Throws AI_ANALYSIS_FAILED if the shape is wrong. Composite scoring (combining
 * with AtsRuleCheckerService output) happens in CvReviewService, not here.
 */
@Injectable()
export class CvReviewParser {
  private readonly logger = new Logger(CvReviewParser.name);

  parse(raw: unknown): CvReviewLlmRawOutput {
    if (!raw || typeof raw !== 'object') {
      this.fail('LLM output was not an object');
    }
    const obj = raw as Record<string, unknown>;

    const scores = this.obj(obj.scores, 'scores');
    const scoresParsed: CvReviewLlmDimensions = {
      action_verbs: this.score20(scores.action_verbs, 'scores.action_verbs'),
      skills_relevance: this.score20(scores.skills_relevance, 'scores.skills_relevance'),
      experience: this.score20(scores.experience, 'scores.experience'),
      education: this.score20(scores.education, 'scores.education'),
    };
    const computedTotal =
      scoresParsed.action_verbs +
      scoresParsed.skills_relevance +
      scoresParsed.experience +
      scoresParsed.education;
    // Use computed total — LLM-reported total may not match. Self-consistency check below.
    const llm_total = computedTotal;
    if (
      typeof obj.llm_total === 'number' &&
      Math.abs((obj.llm_total as number) - computedTotal) > 2
    ) {
      // We always use our own computed total, but a large gap is worth surfacing —
      // it can signal the model ignoring the rubric or tampering via the CV text.
      this.logger.warn(
        `llm_total drift: model reported ${obj.llm_total as number}, computed ${computedTotal} from per-dimension scores`,
      );
    }

    const rationale = this.obj(obj.rationale, 'rationale');
    const rationaleParsed: CvReviewRationale = {
      action_verbs: this.strOrEmpty(rationale.action_verbs),
      skills_relevance: this.strOrEmpty(rationale.skills_relevance),
      experience: this.strOrEmpty(rationale.experience),
      education: this.strOrEmpty(rationale.education),
    };

    const sections = this.arr(obj.sections, 'sections');
    const sectionsParsed: CvReviewSection[] = sections.map((s, idx) => {
      const sObj = this.obj(s, `sections[${idx}]`);
      return {
        name: this.str(sObj.name, `sections[${idx}].name`),
        score: this.clamp(this.num(sObj.score, `sections[${idx}].score`), 0, 100),
        issues: Array.isArray(sObj.issues)
          ? (sObj.issues as Array<Record<string, unknown>>).map((iss, i) => ({
              severity: this.severity(iss.severity, `sections[${idx}].issues[${i}].severity`),
              text: this.str(iss.text, `sections[${idx}].issues[${i}].text`),
              hint: typeof iss.hint === 'string' ? (iss.hint as string) : undefined,
            }))
          : [],
      };
    });

    const extracted = this.obj(obj.ats_extracted, 'ats_extracted');
    const extractedParsed: CvReviewExtracted = {
      name: typeof extracted.name === 'string' ? (extracted.name as string) : null,
      email: typeof extracted.email === 'string' ? (extracted.email as string) : null,
      phone: typeof extracted.phone === 'string' ? (extracted.phone as string) : null,
      skills_raw: Array.isArray(extracted.skills_raw) ? (extracted.skills_raw as string[]) : [],
    };

    return {
      scores: scoresParsed,
      llm_total,
      rationale: rationaleParsed,
      sections: sectionsParsed,
      ats_extracted: extractedParsed,
    };
  }

  // ─── Type helpers ──────────────────────────────────────────────────────────

  private num(v: unknown, name: string): number {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      this.fail(`Expected number at ${name}, got ${typeof v}`);
    }
    return v as number;
  }

  /** Clamp a model-provided numeric score into [min, max] (the LLM may emit out-of-range values). */
  private clamp(n: number, min: number, max: number): number {
    return Math.min(Math.max(n, min), max);
  }

  /** Score that must be 0-20 (clamped if slightly off). */
  private score20(v: unknown, name: string): number {
    const n = this.num(v, name);
    if (n < 0) return 0;
    if (n > 20) return 20;
    return Math.round(n);
  }

  private str(v: unknown, name: string): string {
    if (typeof v !== 'string') {
      this.fail(`Expected string at ${name}, got ${typeof v}`);
    }
    return v as string;
  }

  private strOrEmpty(v: unknown): string {
    return typeof v === 'string' ? (v as string) : '';
  }

  private obj(v: unknown, name: string): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      this.fail(`Expected object at ${name}`);
    }
    return v as Record<string, unknown>;
  }

  private arr(v: unknown, name: string): unknown[] {
    if (!Array.isArray(v)) {
      this.fail(`Expected array at ${name}`);
    }
    return v as unknown[];
  }

  private severity(v: unknown, name: string): 'info' | 'warning' | 'error' {
    if (v === 'info' || v === 'warning' || v === 'error') return v;
    // Tolerate uppercase / shorthand
    if (typeof v === 'string') {
      const lower = v.toLowerCase();
      if (lower === 'info' || lower === 'warn' || lower === 'warning')
        return lower === 'warn' ? 'warning' : (lower as 'info' | 'warning');
      if (lower === 'err' || lower === 'error') return 'error';
    }
    this.fail(`Invalid severity at ${name}: ${String(v)}`);
  }

  private fail(message: string): never {
    throw new BadGatewayException({
      code: ERROR_CODES.AI_ANALYSIS_FAILED,
      message: `CV review parse failed: ${message}`,
    });
  }
}
