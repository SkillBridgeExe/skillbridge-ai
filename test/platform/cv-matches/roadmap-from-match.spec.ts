import { NotFoundException } from '@nestjs/common';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';
import { SkillBridgeGapReport } from '../../../src/modules/gap-report/gap-report.service';
import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';

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
  const roadmap = { generate: jest.fn() };
  const composer = {
    compose: jest.fn().mockReturnValue({
      budget_hours: 34.3,
      steps: [],
      not_feasible_items: [],
      ai_summary: 'deterministic',
    }),
  };
  const service = new (CvMatchesService as any)(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    roadmap as never,
    {} as never,
    composer as never,
  );
  return { service: service as CvMatchesService, roadmap, composer };
}

describe('CvMatchesService.generateRoadmapFromMatch - deterministic composer flow', () => {
  it('builds unified learn items from the GapReport and calls deterministic composer', async () => {
    const { service, roadmap, composer } = build();
    jest.spyOn(service, 'getGapReport').mockResolvedValue(
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

    const out = (await service.generateRoadmapFromMatch('user-1', 'match-1', {
      available_days: 30,
      hours_per_week: 8,
    } as any)) as any;

    expect(service.getGapReport).toHaveBeenCalledWith('user-1', 'match-1');
    expect(roadmap.generate).not.toHaveBeenCalled();
    expect(composer.compose).toHaveBeenCalledTimes(1);
    expect(composer.compose.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        gapItems: expect.any(Array),
        budget: { available_days: 30, hours_per_week: 8 },
      }),
    );
    expect(
      composer.compose.mock.calls[0][0].learnItems.map((item: any) => item.skill_canonical),
    ).toEqual(['react', 'sql']);
    expect(out.ai_summary).toBe('deterministic');
  });

  it('honest empty-state when there are no learning gaps', async () => {
    const { service, roadmap, composer } = build();
    jest.spyOn(service, 'getGapReport').mockResolvedValue(
      report({
        gap_items: [gap({ fixability: 'rewrite' }), gap({ fixability: 'add_evidence' })],
      }),
    );

    const out = (await service.generateRoadmapFromMatch('user-1', 'match-1', {})) as any;

    expect(roadmap.generate).not.toHaveBeenCalled();
    expect(composer.compose).not.toHaveBeenCalled();
    expect(out.no_learning_gaps).toBe(true);
    expect(out.steps).toEqual([]);
  });

  it('passes budget overrides to composer', async () => {
    const { service, composer } = build();
    jest.spyOn(service, 'getGapReport').mockResolvedValue(
      report({
        gap_items: [gap({ canonical_name: 'react', fixability: 'learn', required_level: 4 })],
      }),
    );

    await service.generateRoadmapFromMatch('user-1', 'match-1', {
      available_days: 10,
      hours_per_week: 20,
    } as any);

    expect(composer.compose.mock.calls[0][0].budget).toEqual({
      available_days: 10,
      hours_per_week: 20,
    });
  });

  it('propagates ownership/not-found rejection from getGapReport', async () => {
    const { service, roadmap, composer } = build();
    jest.spyOn(service, 'getGapReport').mockRejectedValue(new NotFoundException());

    await expect(service.generateRoadmapFromMatch('user-1', 'nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(roadmap.generate).not.toHaveBeenCalled();
    expect(composer.compose).not.toHaveBeenCalled();
  });
});
