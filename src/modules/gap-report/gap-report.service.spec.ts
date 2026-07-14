import { GapReportService } from './gap-report.service';
import { TailorChecklistService } from '../cv-jd-match/tailor-checklist.service';
import { JdMarketPositionService } from '../jobs/trends/jd-market-position.service';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { ImpliedSkill } from '../jobs/trends/jd-market-position';

/**
 * Service-level spec for the ACTION' wiring that the pure specs can't see:
 *  - A2: non-skill gap_items flow into the checklist as advice actions, and advice actions are
 *    NEVER fed to simulateActionImpact (it would throw — no partial/missing entry to simulate).
 *  - A3 (user decision 2026-07-12): market stays a SEPARATE surface — implied market skills land
 *    in market_trend_gaps only, never in gap_items or recommended_actions.
 * Market service is stubbed (its DTO is an input here); everything else is the real pure pipeline.
 */

const marketUnavailable = {
  build: async () => ({ available: false as const, reason: 'NO_ROLE' as const }),
} as unknown as JdMarketPositionService;

function impliedSkill(canonical: string): ImpliedSkill {
  return {
    skill_canonical: canonical,
    display_name: canonical.toUpperCase(),
    pct_of_postings: 42,
    posting_count: 10,
    trend_delta: null,
    covered: false,
    why: 'market implies it',
  };
}

const marketAvailable = {
  build: async () => ({
    available: true as const,
    role_code: 'backend',
    period: '2026-06',
    jd_skills: [],
    implied: [impliedSkill('kubernetes')],
  }),
} as unknown as JdMarketPositionService;

/** Minimal persisted-match shape the core+gap pipeline reads (same cast pattern as eval-golden). */
function matchOf(over: Partial<CvJdMatchParsedResponse>): CvJdMatchParsedResponse {
  return {
    target_role: 'Backend Developer',
    overall_score: 55,
    required_coverage: 0.5,
    source_of_requirements: 'jd_extraction',
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [],
    keyword_frequency: [],
    ...over,
  } as unknown as CvJdMatchParsedResponse;
}

const missingDocker = {
  skill_id: 'docker',
  canonical_name: 'docker',
  display_name: 'Docker',
  required_level: 3,
  importance: 'REQUIRED',
  weight: 0.5,
  skill_type: 'hard',
  gap_levels: 3,
};

/** A REQUIRED English-B2 JD dimension: with review=null (CV silent) this grades into a
 *  from-silence `language` non-skill GapItem — no CV document fixture needed. */
const languageDim = {
  dimension: 'language',
  value_text: 'English B2',
  level_hint: null,
  min_years: null,
  importance: 'REQUIRED',
  deal_breaker: false,
  evidence_text: 'English B2 or above required',
};

describe("GapReportService (ACTION' wiring)", () => {
  const service = (market: JdMarketPositionService) =>
    new GapReportService(new TailorChecklistService(), market);

  it('A2: a non-skill gap item produces an advice action joined to its gap item, with NO expected_impact', async () => {
    const report = await service(marketUnavailable).build({
      match: matchOf({
        missing_skills: [missingDocker],
        jd_dimensions: [languageDim],
      } as Partial<CvJdMatchParsedResponse>),
      review: null,
    });

    expect(report.gap_items.some((g) => g.type === 'language')).toBe(true);

    const advice = report.recommended_actions.find((a) => a.action_type === 'advice');
    expect(advice).toBeDefined();
    expect(advice!.skill_canonical).toBe('language');
    expect(advice!.rewrite_eligible).toBe(false);
    expect(advice!.requirement_id).toBe('jd:language:language');
    expect(advice!.fixability).toBe('learn');
    // The simulator has no path for advice (it would THROW on the partial_skills lookup) — the
    // service must skip it, never fabricate an impact.
    expect(advice!.expected_impact).toBeUndefined();

    // Skill actions still get their impact simulation.
    const dockerAction = report.recommended_actions.find(
      (a) => a.skill_canonical === 'docker' && a.action_type === 'missing_required',
    );
    expect(dockerAction).toBeDefined();
    expect(dockerAction!.expected_impact).toBeDefined();
  });

  it('A2: no jd_dimensions → no advice actions (legacy shape unchanged)', async () => {
    const report = await service(marketUnavailable).build({
      match: matchOf({ missing_skills: [missingDocker] } as Partial<CvJdMatchParsedResponse>),
      review: null,
    });

    expect(report.recommended_actions.every((a) => a.action_type !== 'advice')).toBe(true);
  });

  it('A3: implied market skills stay in market_trend_gaps — never in gap_items or recommended_actions', async () => {
    const report = await service(marketAvailable).build({
      match: matchOf({ missing_skills: [missingDocker] } as Partial<CvJdMatchParsedResponse>),
      review: null,
    });

    expect(report.market_trend_gaps?.map((i) => i.skill_canonical)).toEqual(['kubernetes']);
    expect(report.gap_items.some((g) => g.canonical_name === 'kubernetes')).toBe(false);
    expect(report.recommended_actions.some((a) => a.skill_canonical === 'kubernetes')).toBe(false);
    expect(report.gap_items.every((g) => g.source === 'jd' || g.source === 'role_rubric')).toBe(
      true,
    );
  });
});
