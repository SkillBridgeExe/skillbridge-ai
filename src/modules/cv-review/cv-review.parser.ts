import { BadGatewayException, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { CvReviewParsedResponse } from './dto/cv-review-response.dto';

/**
 * Validates LLM JSON output matches the expected CV review schema.
 * Throws AI_ANALYSIS_FAILED if the shape is wrong.
 */
@Injectable()
export class CvReviewParser {
  parse(raw: unknown): CvReviewParsedResponse {
    if (!raw || typeof raw !== 'object') {
      this.fail('LLM output was not an object');
    }
    const obj = raw as Record<string, unknown>;

    const overall = this.num(obj.overall_score, 'overall_score');
    const breakdown = this.obj(obj.breakdown, 'breakdown');
    const sections = this.arr(obj.sections, 'sections');
    const parsedCv = this.obj(obj.parsed_cv, 'parsed_cv');

    return {
      overall_score: overall,
      breakdown: {
        structure: this.num(breakdown.structure, 'breakdown.structure'),
        ats: this.num(breakdown.ats, 'breakdown.ats'),
        skills: this.num(breakdown.skills, 'breakdown.skills'),
        experience: this.num(breakdown.experience, 'breakdown.experience'),
      },
      sections: sections.map((s, idx) => {
        const sObj = this.obj(s, `sections[${idx}]`);
        return {
          name: this.str(sObj.name, `sections[${idx}].name`),
          score: this.num(sObj.score, `sections[${idx}].score`),
          issues: Array.isArray(sObj.issues) ? (sObj.issues as never[]) : [],
        };
      }),
      parsed_cv: {
        name: typeof parsedCv.name === 'string' ? parsedCv.name : null,
        email: typeof parsedCv.email === 'string' ? parsedCv.email : null,
        phone: typeof parsedCv.phone === 'string' ? parsedCv.phone : null,
        skills: Array.isArray(parsedCv.skills) ? (parsedCv.skills as string[]) : [],
      },
    };
  }

  private num(v: unknown, name: string): number {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      this.fail(`Expected number at ${name}, got ${typeof v}`);
    }
    return v as number;
  }

  private str(v: unknown, name: string): string {
    if (typeof v !== 'string') {
      this.fail(`Expected string at ${name}, got ${typeof v}`);
    }
    return v as string;
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

  private fail(message: string): never {
    throw new BadGatewayException({
      code: ERROR_CODES.AI_ANALYSIS_FAILED,
      message: `CV review parse failed: ${message}`,
    });
  }
}
