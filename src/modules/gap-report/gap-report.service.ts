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
import { deriveCvProfileSignals } from '../../common/services/cv-profile-signals';
import { buildGapReportCore, GapReportCore } from './gap-report';
import { buildGapItems, GapItem } from '../gap-engine/gap-item';
import { simulateActionImpact } from './impact-simulator';

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
    /** I3 (Wave IMPACT): platform-fetched github corroboration (opt-in username+consent), converted
     *  to a plain Map BEFORE this call — see CvMatchesService.fetchGithubCorroboration. Optional;
     *  absent on every non-opted-in request ⇒ passed through as a no-op to buildGapItems. */
    corroborated?: Map<string, { ref: string }> | null;
    /** V1 (Wave VALUE_CHAIN): platform-fetched real interview outcomes for this match (latest
     *  completed session), converted to a plain Map BEFORE this call — see
     *  fetchInterviewSignals (src/platform/interviews/interview-signals.ts, shared with TailorVerifier). Optional; absent whenever no interview exists ⇒
     *  passed through as a no-op to buildGapItems. */
    interviewSignals?: Map<string, { risk: number; ref: string }> | null;
  }): Promise<SkillBridgeGapReport> {
    const lang = input.lang ?? 'vi';
    const ledger = input.review?.evidence_ledger ?? null;
    const cvSeniority = input.review?.document
      ? deriveCvSeniority(input.review.document, new Date().getFullYear())
      : null;
    // PR3b: CV-side profile signals (english/education/domain/work_mode) for the jd_intelligence
    // disclosure. Derived once from the parsed CV; additive (only fills cv_signal, no score change).
    const cvProfileSignals = input.review?.document
      ? deriveCvProfileSignals(input.review.document)
      : null;

    const core = buildGapReportCore(input.match, ledger, cvSeniority, cvProfileSignals, lang);
    const marketDto = await this.market.build({ match: input.match, lang });

    // PR1: per-requirement market demand (pct_of_postings) when a snapshot exists — else the
    // builder defaults market_demand to null. No new computation; reads the positioning DTO.
    const marketDemand = marketDto.available
      ? new Map(marketDto.jd_skills.map((s) => [s.skill_canonical, s.pct_of_postings] as const))
      : null;

    // PR3/PR3c: feed extracted JD dimensions + CV seniority + CV profile signals — seniority/language/
    // education/domain grade into GapItems (work_mode is disclosure-only); absent (v1 path) ⇒
    // byte-identical to before. Built ONCE here and reused for gap_items, the checklist ranking
    // below (A2), and the PR4 patch decorator (no recomputation).
    const gapItems = buildGapItems({
      match: input.match,
      ledger,
      marketDemand,
      jdDimensions: input.match.jd_dimensions ?? null,
      cvSeniority,
      cvProfileSignals,
      corroborated: input.corroborated ?? null,
      interviewSignals: input.interviewSignals ?? null,
    });

    // A2: rank recommended_actions by the SAME severity as gap_items (fixes B3 — action #1 could
    // contradict gap #1). Built from gapItems (already computed here) and passed INTO the checklist
    // builder rather than re-derived/joined downstream. ACTION': the non-skill gap items also flow
    // in, so a top seniority/language/education/domain gap yields an `advice` action instead of
    // silently having no next step.
    const severityByCanonical = new Map(gapItems.map((g) => [g.canonical_name, g.severity]));
    const nonSkillGaps = gapItems.filter(
      (g) => g.type !== 'hard_skill' && g.type !== 'soft_skill',
    );
    const checklist = this.tailor.build({
      match: input.match,
      review: input.review,
      lang,
      severityByCanonical,
      nonSkillGaps,
    });

    // PR4: enrich the checklist into a deterministic patch plan (joins gap_items by skill_canonical).
    const patched = decorateWithPatch({
      actions: checklist.actions,
      gapItems,
      document: input.review?.document ?? null,
      lang,
    });

    // I1 (Wave IMPACT): deterministic what-if score/severity impact per action, computed AFTER
    // decorateWithPatch (never re-runs diff() — recomputes from the SAME persisted match arrays).
    // Absent join (no gap_item, or no matching missing/partial entry for a score-moving action) ⇒
    // NO expected_impact field — never a fabricated 0-0.
    const gapByCanonical = new Map(gapItems.map((g) => [g.canonical_name, g]));
    const missingCanonicals = new Set(input.match.missing_skills.map((m) => m.canonical_name));
    const partialCanonicals = new Set(input.match.partial_skills.map((p) => p.canonical_name));
    const recommendedActions = patched.map((a) => {
      // ACTION' A2: advice actions have no CV-patch/score path — simulateActionImpact would THROW
      // on the partial/missing lookup. No expected_impact is the honest value (never a 0-0).
      if (a.action_type === 'advice') return a;
      const gi = gapByCanonical.get(a.skill_canonical);
      if (!gi) return a;
      const joined =
        a.action_type === 'missing_required'
          ? missingCanonicals.has(a.skill_canonical)
          : a.action_type === 'deepen_wording'
            ? partialCanonicals.has(a.skill_canonical)
            : true; // add_evidence/emphasize only need the gap_item — score is always 0-0
      if (!joined) return a;
      // Re-supply the item's interview signal (Wave 8): gi.severity was raised with it, so the
      // simulator's after-fix severity must carry it too or severity_drop over-promises.
      return {
        ...a,
        expected_impact: simulateActionImpact(input.match, gi, a, {
          interviewRiskSignal: input.interviewSignals?.get(gi.canonical_name)?.risk,
        }),
      };
    });

    return {
      ...core,
      recommended_actions: recommendedActions,
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
