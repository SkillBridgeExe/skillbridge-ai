import { NotFoundException } from '@nestjs/common';
import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';
import { SkillBridgeGapReport } from '../../../src/modules/gap-report/gap-report.service';
import { RoadmapGenerateRequestDto } from '../../../src/modules/roadmap/dto/roadmap-request.dto';

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
  const roadmap = {
    generate: jest.fn().mockResolvedValue({
      ai_request_id: 'r1',
      retrieval_log_id: null,
      retrieved_chunks_count: 0,
      token_usage: 100,
      parsed_response: {
        title: 'Lộ trình',
        total_weeks: 4,
        phases: [],
        steps: [],
        ai_summary: '',
        ai_advice: '',
        uncovered_skills: [],
        skills_without_courses: [],
      },
    }),
  };
  // getGapReport is spied per-test, so the load/ownership deps stay unmocked ({} as never).
  const service = new CvMatchesService(
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
  );
  return { service, roadmap };
}

describe('CvMatchesService.generateRoadmapFromMatch — server-derived gaps (learn-only)', () => {
  it('derives learn gaps from the GapReport and calls roadmap.generate (NO client-supplied skills)', async () => {
    const { service, roadmap } = build();
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
          gap({ canonical_name: 'docker', fixability: 'rewrite' }), // CV-tailoring, not learning → dropped
        ],
      }),
    );

    const out = await service.generateRoadmapFromMatch('user-1', 'match-1', {});

    expect(service.getGapReport).toHaveBeenCalledWith('user-1', 'match-1');
    expect(roadmap.generate).toHaveBeenCalledTimes(1);
    const [uid, input] = roadmap.generate.mock.calls[0] as [string, RoadmapGenerateRequestDto];
    expect(uid).toBe('user-1');
    expect(input.target_role).toBe('backend_developer');
    expect(input.prompt_template_code).toBe('roadmap_v1');
    expect(input.hours_per_week).toBe(8); // product default
    expect(input.missing_skills.map((s) => s.skill_canonical_name)).toEqual(['react']);
    expect(input.partial_skills?.map((s) => s.skill_canonical_name)).toEqual(['sql']);
    expect(out.parsed_response.title).toBe('Lộ trình');
  });

  it('honest empty-state when there are no LEARNING gaps (no LLM call, no_learning_gaps=true)', async () => {
    const { service, roadmap } = build();
    jest.spyOn(service, 'getGapReport').mockResolvedValue(
      report({
        gap_items: [gap({ fixability: 'rewrite' }), gap({ fixability: 'add_evidence' })],
      }),
    );

    const out = await service.generateRoadmapFromMatch('user-1', 'match-1', {});

    expect(roadmap.generate).not.toHaveBeenCalled();
    expect(out.parsed_response.no_learning_gaps).toBe(true);
    expect(out.parsed_response.steps).toEqual([]);
    expect(out.ai_request_id).toBe('');
  });

  it('passes through caller overrides (hours_per_week, prompt_template_code, user_profile)', async () => {
    const { service, roadmap } = build();
    jest.spyOn(service, 'getGapReport').mockResolvedValue(
      report({
        gap_items: [gap({ canonical_name: 'react', fixability: 'learn', required_level: 4 })],
      }),
    );

    await service.generateRoadmapFromMatch('user-1', 'match-1', {
      hours_per_week: 20,
      prompt_template_code: 'roadmap_v2',
      user_profile: { goal: 'switch' },
    });

    const input = roadmap.generate.mock.calls[0][1] as RoadmapGenerateRequestDto;
    expect(input.hours_per_week).toBe(20);
    expect(input.prompt_template_code).toBe('roadmap_v2');
    expect(input.user_profile).toEqual({ goal: 'switch' });
  });

  it('propagates ownership/not-found rejection from getGapReport (no roadmap call)', async () => {
    const { service, roadmap } = build();
    jest.spyOn(service, 'getGapReport').mockRejectedValue(new NotFoundException());

    await expect(service.generateRoadmapFromMatch('user-1', 'nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(roadmap.generate).not.toHaveBeenCalled();
  });
});
