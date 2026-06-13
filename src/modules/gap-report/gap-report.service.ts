import { Injectable } from '@nestjs/common';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { TailorChecklistService } from '../cv-jd-match/tailor-checklist.service';
import { decorateWithPatch, PatchedTailorAction } from '../cv-jd-match/cv-patch';
import {
  JdMarketPositionDto,
  JdMarketPositionService,
} from '../jobs/trends/jd-market-position.service';
import { ImpliedSkill } from '../jobs/trends/jd-market-position';
import { deriveCvSeniority } from '../../common/services/seniority';
import { buildGapReportCore, GapReportCore } from './gap-report';
import { buildGapItems, GapItem } from '../gap-engine/gap-item';

export interface SkillBridgeGapReport extends GapReportCore {
  /** Distilled trend GAPS (implied & not covered) — the downstream signal (roadmap/interview). */
  market_trend_gaps: ImpliedSkill[] | null;
  /** PR4: the tailor checklist, enriched into a deterministic CV-patch plan (section / stable
   *  action_id / fixability / a verbatim `before` only when evidence-backed). Superset of TailorAction. */
  recommended_actions: PatchedTailorAction[];
  generated_with_ledger: boolean;
  market:
    | { available: true; role_code: string; period: string }
    | { available: false; reason: 'NO_ROLE' | 'NO_SNAPSHOT' };
  /** Full positioning DTO (per-requirement niche/standard/common + implied incl. covered) —
   *  the W12 "đọc vị JD" display block; market_trend_gaps above is its distilled subset. */
  jd_market_position: JdMarketPositionDto;
  /** Gap Engine v2 FOUNDATION (PR1): JD/rubric requirements as canonical GapItem[]. Additive —
   *  the groups above are unchanged. NOTE: market-implied gaps are NOT here yet (they remain in
   *  `market_trend_gaps`); folding them in + re-expressing the groups on top is a later PR. */
  gap_items: GapItem[];
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

    // PR1: per-requirement market demand (pct_of_postings) when a snapshot exists — else the
    // builder defaults market_demand to null. No new computation; reads the positioning DTO.
    const marketDemand = marketDto.available
      ? new Map(marketDto.jd_skills.map((s) => [s.skill_canonical, s.pct_of_postings] as const))
      : null;

    // PR3: feed extracted JD dimensions + CV seniority — only `seniority` becomes a graded GapItem;
    // absent (v1 path) ⇒ byte-identical to before. The other dims surface in core.jd_intelligence.
    // Built ONCE here and reused for BOTH gap_items and the PR4 patch decorator (no recomputation).
    const gapItems = buildGapItems({
      match: input.match,
      ledger,
      marketDemand,
      jdDimensions: input.match.jd_dimensions ?? null,
      cvSeniority,
    });

    return {
      ...core,
      // PR4: enrich the checklist into a deterministic patch plan (joins gap_items by skill_canonical).
      recommended_actions: decorateWithPatch({
        actions: checklist.actions,
        gapItems,
        document: input.review?.document ?? null,
        lang,
      }),
      generated_with_ledger: checklist.generated_with_ledger,
      market_trend_gaps: marketDto.available ? marketDto.implied.filter((i) => !i.covered) : null,
      market: marketDto.available
        ? { available: true, role_code: marketDto.role_code, period: marketDto.period }
        : { available: false, reason: marketDto.reason },
      jd_market_position: marketDto,
      gap_items: gapItems,
    };
  }
}
