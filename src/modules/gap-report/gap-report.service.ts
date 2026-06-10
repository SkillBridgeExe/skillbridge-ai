import { Injectable } from '@nestjs/common';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { TailorChecklistService } from '../cv-jd-match/tailor-checklist.service';
import { TailorAction } from '../cv-jd-match/tailor-checklist';
import {
  JdMarketPositionDto,
  JdMarketPositionService,
} from '../jobs/trends/jd-market-position.service';
import { ImpliedSkill } from '../jobs/trends/jd-market-position';
import { deriveCvSeniority } from '../../common/services/seniority';
import { buildGapReportCore, GapReportCore } from './gap-report';

export interface SkillBridgeGapReport extends GapReportCore {
  /** Distilled trend GAPS (implied & not covered) — the downstream signal (roadmap/interview). */
  market_trend_gaps: ImpliedSkill[] | null;
  recommended_actions: TailorAction[];
  generated_with_ledger: boolean;
  market:
    | { available: true; role_code: string; period: string }
    | { available: false; reason: 'NO_ROLE' | 'NO_SNAPSHOT' };
  /** Full positioning DTO (per-requirement niche/standard/common + implied incl. covered) —
   *  the W12 "đọc vị JD" display block; market_trend_gaps above is its distilled subset. */
  jd_market_position: JdMarketPositionDto;
}

/**
 * Gap Engine v1 — the ONE unified gap output (Codex P0 #1). Composes ONLY already-shipped,
 * eval-gated signals; recomputes nothing; NO LLM; never-throw for expected degrades.
 * Exported for the platform route GET /api/cv-matches/:matchId/gap-report (REPLACES the
 * separate tailor-checklist route — the report carries recommended_actions + market blocks).
 */
@Injectable()
export class GapReportService {
  constructor(
    private readonly tailor: TailorChecklistService,
    private readonly market: JdMarketPositionService,
  ) {}

  async build(input: {
    match: CvJdMatchParsedResponse;
    review: CvReviewParsedResponse | null;
    lang?: 'vi' | 'en';
  }): Promise<SkillBridgeGapReport> {
    const lang = input.lang ?? 'vi';
    const ledger = input.review?.evidence_ledger ?? null;
    const cvSeniority = input.review?.document
      ? deriveCvSeniority(input.review.document, new Date().getFullYear())
      : null;

    const core = buildGapReportCore(input.match, ledger, cvSeniority, lang);
    const checklist = this.tailor.build({ match: input.match, review: input.review, lang });
    const marketDto = await this.market.build({ match: input.match, lang });

    return {
      ...core,
      recommended_actions: checklist.actions,
      generated_with_ledger: checklist.generated_with_ledger,
      market_trend_gaps: marketDto.available ? marketDto.implied.filter((i) => !i.covered) : null,
      market: marketDto.available
        ? { available: true, role_code: marketDto.role_code, period: marketDto.period }
        : { available: false, reason: marketDto.reason },
      jd_market_position: marketDto,
    };
  }
}
