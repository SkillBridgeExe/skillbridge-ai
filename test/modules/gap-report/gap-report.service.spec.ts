import { Test, TestingModule } from '@nestjs/testing';
import { GapReportService } from '../../../src/modules/gap-report/gap-report.service';
import { TailorChecklistService } from '../../../src/modules/cv-jd-match/tailor-checklist.service';
import { JdMarketPositionService } from '../../../src/modules/jobs/trends/jd-market-position.service';
import { CvJdMatchParsedResponse } from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { CvReviewParsedResponse } from '../../../src/modules/cv-review/dto/cv-review-response.dto';
import { TailorAction } from '../../../src/modules/cv-jd-match/tailor-checklist';
import { ImpliedSkill } from '../../../src/modules/jobs/trends/jd-market-position';

const baseMatch = (): CvJdMatchParsedResponse =>
  ({
    overall_score: 72,
    match_ratio: 60,
    required_coverage: 0.6,
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [],
    unnormalized_cv_skills: [],
    unnormalized_jd_requirements: [],
    scoring_breakdown: {
      total_requirements: 0,
      matched_count: 0,
      partial_count: 0,
      missing_count: 0,
      weight_sum: 0,
      achieved_weight: 0,
      required_total: 0,
      required_met: 0,
      raw_weighted_score: 0,
      cap_applied: false,
    },
    source_of_requirements: 'jd_extraction',
    target_role: 'backend_developer',
  }) as CvJdMatchParsedResponse;

const action = (p: string): TailorAction =>
  ({
    priority: p,
    action: `do ${p}`,
    reason: 'test',
    category: 'keyword',
  }) as unknown as TailorAction;

const impliedSkill = (c: string, covered: boolean): ImpliedSkill => ({
  skill_canonical: c,
  display_name: c.toUpperCase(),
  pct_of_postings: 60,
  posting_count: 50,
  trend_delta: null,
  covered,
  why: 'market implied',
});

describe('GapReportService', () => {
  let service: GapReportService;
  let tailorMock: { build: jest.Mock };
  let marketMock: { build: jest.Mock };

  beforeEach(async () => {
    tailorMock = { build: jest.fn() };
    marketMock = { build: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GapReportService,
        { provide: TailorChecklistService, useValue: tailorMock as never },
        { provide: JdMarketPositionService, useValue: marketMock as never },
      ],
    }).compile();

    service = module.get<GapReportService>(GapReportService);
  });

  it('(a) happy path: actions passed through, only uncovered skills in market_trend_gaps, core present', async () => {
    tailorMock.build.mockReturnValue({
      actions: [action('P0'), action('P1')],
      generated_with_ledger: true,
      source_of_requirements: 'jd_extraction',
      overall_score: 72,
    });
    marketMock.build.mockResolvedValue({
      available: true,
      role_code: 'backend_developer',
      period: '2026-Q2',
      total_active_jobs: 100,
      jd_skills: [],
      implied: [impliedSkill('docker', true), impliedSkill('kubernetes', false)],
    });

    const report = await service.build({ match: baseMatch(), review: null });

    expect(report.recommended_actions).toHaveLength(2);
    expect(report.recommended_actions[0]).toMatchObject({ priority: 'P0' });
    expect(report.market_trend_gaps).toHaveLength(1);
    expect(report.market_trend_gaps![0].skill_canonical).toBe('kubernetes');
    expect(report.market).toEqual({
      available: true,
      role_code: 'backend_developer',
      period: '2026-Q2',
    });
    expect(report.overall_score).toBe(72);
    expect(report.target_role).toBe('backend_developer');
    expect(report.explicit_gaps).toEqual([]);
  });

  it('(a2) attaches unified gap_items (additive); market_demand lifted from jd_skills', async () => {
    tailorMock.build.mockReturnValue({
      actions: [],
      generated_with_ledger: false,
      source_of_requirements: 'jd_extraction',
      overall_score: 72,
    });
    marketMock.build.mockResolvedValue({
      available: true,
      role_code: 'backend_developer',
      period: '2026-Q2',
      total_active_jobs: 100,
      jd_skills: [{ skill_canonical: 'kubernetes', pct_of_postings: 62 }],
      implied: [],
    });
    const match = baseMatch();
    match.missing_skills = [
      {
        skill_id: 'kubernetes',
        canonical_name: 'kubernetes',
        display_name: 'Kubernetes',
        required_level: 4,
        importance: 'REQUIRED',
        weight: 0.2,
        skill_type: 'hard',
        gap_levels: 4,
      },
    ] as never;

    const report = await service.build({ match, review: null });

    expect(Array.isArray(report.gap_items)).toBe(true);
    const k = report.gap_items.find((g) => g.canonical_name === 'kubernetes');
    expect(k).toMatchObject({ cv_status: 'missing', fixability: 'learn', market_demand: 62 });
  });

  it('(b) market unavailable → market_trend_gaps: null, reason echoed', async () => {
    tailorMock.build.mockReturnValue({
      actions: [],
      generated_with_ledger: false,
      source_of_requirements: 'jd_extraction',
      overall_score: 72,
    });
    marketMock.build.mockResolvedValue({ available: false, reason: 'NO_ROLE' });

    const report = await service.build({ match: baseMatch(), review: null });

    expect(report.market_trend_gaps).toBeNull();
    expect(report.market).toEqual({ available: false, reason: 'NO_ROLE' });
  });

  it('(c) review null → seniority.cv null + generated_with_ledger from checklist mock', async () => {
    tailorMock.build.mockReturnValue({
      actions: [],
      generated_with_ledger: false,
      source_of_requirements: 'jd_extraction',
      overall_score: 72,
    });
    marketMock.build.mockResolvedValue({ available: false, reason: 'NO_SNAPSHOT' });

    const report = await service.build({ match: baseMatch(), review: null });

    expect(report.seniority.cv).toBeNull();
    expect(report.generated_with_ledger).toBe(false);
  });

  it('(d) review with document → seniority.cv.bucket present', async () => {
    tailorMock.build.mockReturnValue({
      actions: [],
      generated_with_ledger: true,
      source_of_requirements: 'jd_extraction',
      overall_score: 72,
    });
    marketMock.build.mockResolvedValue({ available: false, reason: 'NO_SNAPSHOT' });

    const minimalDocument = {
      experience: [],
      projects: [{ title: 'Project A' }],
    };

    const review = {
      document: minimalDocument,
      evidence_ledger: null,
    } as unknown as CvReviewParsedResponse;

    const report = await service.build({ match: baseMatch(), review });

    expect(report.seniority.cv).not.toBeNull();
    expect(report.seniority.cv!.bucket).toBeDefined();
  });

  it('(e) v2 path: jd_dimensions flow to jd_intelligence + gap_items (language/education/domain), score unchanged', async () => {
    tailorMock.build.mockReturnValue({
      actions: [],
      generated_with_ledger: true,
      source_of_requirements: 'jd_extraction',
      overall_score: 72,
    });
    marketMock.build.mockResolvedValue({ available: false, reason: 'NO_SNAPSHOT' });

    // A v2-shaped match: skill arrays unchanged + normalized jd_dimensions (what cv_jd_match_v2 yields).
    const match = baseMatch();
    match.jd_dimensions = [
      {
        dimension: 'language',
        value_text: 'English B2',
        level_hint: 'B2',
        min_years: null,
        importance: 'REQUIRED',
        deal_breaker: false,
        evidence_text: 'English B2 required',
      },
      {
        dimension: 'education',
        value_text: "Bachelor's degree",
        level_hint: null,
        min_years: null,
        importance: 'REQUIRED',
        deal_breaker: false,
        evidence_text: "Bachelor's degree in Computer Science required",
      },
      {
        dimension: 'domain',
        value_text: 'fintech',
        level_hint: null,
        min_years: null,
        importance: 'PREFERRED',
        deal_breaker: false,
        evidence_text: 'fintech / payment gateway experience',
      },
    ] as never;

    // CV: English B1 (below B2), no degree (silent), ecommerce domain (≠ fintech).
    const document = {
      language: 'en',
      contact: { name: null, email: null, phone: null, location: null, links: [] },
      summary: '',
      education: [],
      experience: [],
      projects: [
        {
          name: 'Shop',
          role: null,
          tech: [],
          bullets: ['Built an e-commerce marketplace'],
          link: null,
        },
      ],
      skills: { technical: [], soft: [], languages: ['English (B1)'], tools: [] },
      certifications: [],
      activities: [],
    };
    const review = { document, evidence_ledger: null } as unknown as CvReviewParsedResponse;

    const report = await service.build({ match, review });

    const dims = (report.jd_intelligence?.dimensions ?? []).map((d) => d.dimension);
    expect(dims).toEqual(expect.arrayContaining(['language', 'education', 'domain']));

    const byType = new Map(report.gap_items.map((g) => [g.type, g]));
    expect(byType.get('language')?.cv_status).toBe('partial'); // B1 one below B2
    expect(byType.get('education')?.cv_status).toBe('missing'); // CV-silent + REQUIRED
    expect(byType.get('domain')?.cv_status).toBe('missing'); // ecommerce ≠ fintech

    // gap_items NEVER recompute the score — it is the verbatim match score.
    expect(report.overall_score).toBe(72);
  });
});
