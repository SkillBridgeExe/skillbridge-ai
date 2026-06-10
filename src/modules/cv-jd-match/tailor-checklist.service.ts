import { Injectable } from '@nestjs/common';
import { CvJdMatchParsedResponse } from './dto/cv-jd-match-response.dto';
import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { buildTailorChecklist, TailorAction } from './tailor-checklist';

export interface TailorChecklistResponseDto {
  actions: TailorAction[];
  /** false → the CV has no review/ledger yet; evidence-based rules (2,4) were skipped. */
  generated_with_ledger: boolean;
  /** Echoed from the match for FE convenience — NEVER recomputed. */
  source_of_requirements: CvJdMatchParsedResponse['source_of_requirements'];
  overall_score: number;
}

/**
 * Thin wrapper over the pure checklist — exported for the platform layer (Tuấn), which fronts
 * GET /api/cv-matches/:matchId/tailor-checklist (JWT + ownership + load match parsed_response
 * + latest cv_review parsed_response, then calls build()). Deterministic, NO LLM, no tracing row.
 */
@Injectable()
export class TailorChecklistService {
  build(input: {
    match: CvJdMatchParsedResponse;
    review: CvReviewParsedResponse | null;
    lang?: 'vi' | 'en';
  }): TailorChecklistResponseDto {
    const ledger = input.review?.evidence_ledger ?? null;
    return {
      actions: buildTailorChecklist(input.match, ledger, input.lang ?? 'vi'),
      generated_with_ledger: ledger !== null,
      source_of_requirements: input.match.source_of_requirements,
      overall_score: input.match.overall_score,
    };
  }
}
