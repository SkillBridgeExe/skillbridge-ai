import { NotFoundException } from '@nestjs/common';
import { BillingFeatureKey } from '../../../src/common/constants/billing.constants';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';
import {
  GapReportService,
  SkillBridgeGapReport,
} from '../../../src/modules/gap-report/gap-report.service';
import { ComposedRoadmap } from '../../../src/modules/roadmap/roadmap-composer';
import { RoadmapComposerService } from '../../../src/modules/roadmap/roadmap-composer.service';
import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';
import { RoadmapFromMatchDto } from '../../../src/platform/cv-matches/dto/roadmap-from-match.dto';

type RoadmapComposerInput = Parameters<RoadmapComposerService['compose']>[0];

const gap = (over: Partial<GapItem>): GapItem =>
  ({
    requirement_id: 'x',
    source: 'jd',
    type: 'hard_skill',
    canonical_name: 'x',
    display_name: 'X',
    importance: 'REQUIRED',
    cv_status: 'missing',
    cv_level: null,
    required_level: 3,
    gap_levels: 3,
    satisfied_by: null,
    evidence_refs: [],
    evidence_risk: 'none',
    fixability: 'learn',
    market_demand: null,
    severity: 0.5,
    confidence: 1,
    recommended_next_action: '',
    ...over,
  }) as GapItem;

const report = (over: Partial<SkillBridgeGapReport>): SkillBridgeGapReport =>
  ({ target_role: 'backend_developer', gap_items: [], ...over }) as SkillBridgeGapReport;

function build() {
  const cvs = {
    findOne: jest.fn().mockResolvedValue({ id: 'cv-1', userId: 'user-1' }),
  };
  const matches = {
    findOne: jest.fn().mockResolvedValue({
      id: 'match-1',
      cvId: 'cv-1',
      jobDescriptionId: null,
      aiResultId: null,
      overallScore: '72.00',
      semanticScore: '68.00',
      ruleEngineScore: '60.00',
      strengths: [],
      weaknesses: [],
      suggestions: {},
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    }),
  };
  const aiResults = { findOne: jest.fn() };
  const entitlements = {
    assertCanUse: jest.fn().mockResolvedValue(undefined),
    recordUsage: jest.fn().mockResolvedValue(undefined),
  };
  const gapReport: jest.Mocked<Pick<GapReportService, 'build'>> = {
    build: jest.fn(),
  };
  const platformCvs = { getLatestReview: jest.fn().mockResolvedValue(null) };
  const roadmap = { generate: jest.fn() };
  const composer: jest.Mocked<Pick<RoadmapComposerService, 'compose'>> = {
    compose: jest.fn<ComposedRoadmap, [RoadmapComposerInput]>().mockReturnValue({
      budget_hours: 34.3,
      steps: [],
      not_feasible_items: [],
      ai_summary: 'deterministic',
    }),
  };
  const learningPreferences = { findOne: jest.fn().mockResolvedValue(null) };
  const service = new CvMatchesService(
    cvs as never,
    {} as never,
    matches as never,
    {} as never,
    aiResults as never,
    {} as never,
    {} as never,
    entitlements as never,
    gapReport as never,
    platformCvs as never,
    {} as never,
    roadmap as never,
    {} as never,
    composer as never,
    learningPreferences as never,
  );
  return {
    service: service as CvMatchesService,
    cvs,
    matches,
    aiResults,
    entitlements,
    gapReport,
    platformCvs,
    roadmap,
    composer,
    learningPreferences,
  };
}

describe('CvMatchesService.generateRoadmapFromMatch - deterministic composer flow', () => {
  it('builds unified learn items from the GapReport and calls deterministic composer', async () => {
    const { service, roadmap, composer, entitlements, gapReport, platformCvs } = build();
    gapReport.build.mockResolvedValue(
      report({
        target_role: 'backend_developer',
        gap_items: [
          gap({
            canonical_name: 'react',
            cv_status: 'missing',
            fixability: 'learn',
            required_level: 4,
          }),
          gap({
            canonical_name: 'sql',
            cv_status: 'partial',
            cv_level: 2,
            fixability: 'learn',
            required_level: 3,
          }),
          gap({ canonical_name: 'docker', fixability: 'rewrite' }),
        ],
      }),
    );

    const dto: RoadmapFromMatchDto = {
      available_days: 30,
      hours_per_week: 8,
    };
    const out = await service.generateRoadmapFromMatch('user-1', 'match-1', dto);

    expect(entitlements.assertCanUse).toHaveBeenCalledWith(
      'user-1',
      BillingFeatureKey.ROADMAP_GENERATE,
    );
    expect(platformCvs.getLatestReview).toHaveBeenCalledWith('user-1', 'cv-1');
    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({
        review: null,
        lang: 'vi',
      }),
    );
    expect(roadmap.generate).not.toHaveBeenCalled();
    expect(composer.compose).toHaveBeenCalledTimes(1);
    expect(composer.compose.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        gapItems: expect.any(Array),
        budget: { available_days: 30, hours_per_week: 8 },
        languagePref: 'both',
      }),
    );
    expect(
      composer.compose.mock.calls[0][0].learnItems.map((item) => item.skill_canonical),
    ).toEqual(['react', 'sql']);
    expect(entitlements.recordUsage).toHaveBeenCalledWith(
      'user-1',
      BillingFeatureKey.ROADMAP_GENERATE,
      { sourceType: 'cv_match', sourceId: 'match-1' },
    );
    expect(out.ai_summary).toBe('deterministic');
  });

  it('honest empty-state when there are no learning gaps', async () => {
    const { service, roadmap, composer, entitlements, gapReport } = build();
    gapReport.build.mockResolvedValue(
      report({
        gap_items: [gap({ fixability: 'rewrite' }), gap({ fixability: 'add_evidence' })],
      }),
    );

    const out = await service.generateRoadmapFromMatch('user-1', 'match-1', {});

    expect(roadmap.generate).not.toHaveBeenCalled();
    expect(composer.compose).not.toHaveBeenCalled();
    expect(out.no_learning_gaps).toBe(true);
    expect(out.steps).toEqual([]);
    expect(entitlements.recordUsage).toHaveBeenCalledWith(
      'user-1',
      BillingFeatureKey.ROADMAP_GENERATE,
      { sourceType: 'cv_match', sourceId: 'match-1' },
    );
  });

  it('passes budget overrides to composer', async () => {
    const { service, composer, gapReport } = build();
    gapReport.build.mockResolvedValue(
      report({
        gap_items: [gap({ canonical_name: 'react', fixability: 'learn', required_level: 4 })],
      }),
    );

    const dto: RoadmapFromMatchDto = {
      available_days: 10,
      hours_per_week: 20,
    };
    await service.generateRoadmapFromMatch('user-1', 'match-1', dto);

    expect(composer.compose.mock.calls[0][0].budget).toEqual({
      available_days: 10,
      hours_per_week: 20,
    });
  });

  it('passes language preference to composer', async () => {
    const { service, composer, gapReport } = build();
    gapReport.build.mockResolvedValue(
      report({
        gap_items: [gap({ canonical_name: 'react', fixability: 'learn', required_level: 4 })],
      }),
    );

    const dto: RoadmapFromMatchDto = {
      language_pref: 'en',
    };
    await service.generateRoadmapFromMatch('user-1', 'match-1', dto);

    expect(composer.compose.mock.calls[0][0].languagePref).toBe('en');
  });

  it('uses persisted learning preferences as roadmap defaults', async () => {
    const { service, composer, learningPreferences, gapReport } = build();
    learningPreferences.findOne.mockResolvedValue({
      userId: 'user-1',
      languagePref: 'vi',
      availableDays: 21,
      hoursPerWeek: 5,
    });
    gapReport.build.mockResolvedValue(
      report({
        gap_items: [gap({ canonical_name: 'react', fixability: 'learn', required_level: 4 })],
      }),
    );

    await service.generateRoadmapFromMatch('user-1', 'match-1', {});

    expect(learningPreferences.findOne).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(composer.compose.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        budget: { available_days: 21, hours_per_week: 5 },
        languagePref: 'vi',
      }),
    );
  });

  it('propagates ownership/not-found rejection before roadmap work', async () => {
    const { service, matches, roadmap, composer, entitlements, gapReport } = build();
    matches.findOne.mockResolvedValue(null);

    await expect(service.generateRoadmapFromMatch('user-1', 'nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(entitlements.assertCanUse).not.toHaveBeenCalled();
    expect(gapReport.build).not.toHaveBeenCalled();
    expect(roadmap.generate).not.toHaveBeenCalled();
    expect(composer.compose).not.toHaveBeenCalled();
  });
});
