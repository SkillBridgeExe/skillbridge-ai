import { NotFoundException } from '@nestjs/common';
import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';
import { SkillBridgeGapReport } from '../../../src/modules/gap-report/gap-report.service';
import { InterviewFocusArea } from '../../../src/modules/interview/interview-planner';

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
  const interviewPlan = {
    phrasePlan: jest.fn().mockResolvedValue({
      ai_request_id: 'req-1',
      target_role: 'backend_developer',
      language: 'vi',
      items: [
        { skill_canonical: 'react', focus_type: 'gap_probe', question: 'Q', good_answer_hints: [] },
      ],
      llm_enhanced: true,
      token_usage: 50,
    }),
  };
  // getGapReport is spied per-test, so the load/ownership deps stay unmocked ({} as never).
  // 13 positional args: ...config(11), roadmap(12), interviewPlan(13).
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
    {} as never,
    interviewPlan as never,
  );
  return { service, interviewPlan };
}

describe('CvMatchesService.generateInterviewPlanFromMatch — server-derived gaps (skill-only)', () => {
  it('derives skill-type focus areas from the GapReport and calls phrasePlan (NO client skills)', async () => {
    const { service, interviewPlan } = build();
    jest.spyOn(service, 'getGapReport').mockResolvedValue(
      report({
        target_role: 'backend_developer',
        gap_items: [
          gap({ canonical_name: 'react', cv_status: 'missing', importance: 'REQUIRED' }),
          gap({ type: 'seniority', canonical_name: 'seniority', cv_status: 'missing' }), // excluded
        ],
      }),
    );

    const out = await service.generateInterviewPlanFromMatch('user-1', 'match-1', {});

    expect(service.getGapReport).toHaveBeenCalledWith('user-1', 'match-1', 'vi');
    expect(interviewPlan.phrasePlan).toHaveBeenCalledTimes(1);
    const [uid, focusAreas, role, lang] = interviewPlan.phrasePlan.mock.calls[0] as [
      string,
      InterviewFocusArea[],
      string,
      string,
    ];
    expect(uid).toBe('user-1');
    expect(role).toBe('backend_developer');
    expect(lang).toBe('vi');
    expect(focusAreas.map((f) => f.skill_canonical)).toEqual(['react']); // seniority excluded
    expect(out.items).toHaveLength(1);
  });

  it('honest empty-state when there are no skill-type gaps (no LLM call, no_focus_areas=true)', async () => {
    const { service, interviewPlan } = build();
    jest.spyOn(service, 'getGapReport').mockResolvedValue(
      report({
        target_role: 'backend_developer',
        gap_items: [gap({ type: 'seniority', canonical_name: 'seniority', cv_status: 'missing' })],
      }),
    );

    const out = await service.generateInterviewPlanFromMatch('user-1', 'match-1', {});

    expect(interviewPlan.phrasePlan).not.toHaveBeenCalled();
    expect(out.no_focus_areas).toBe(true);
    expect(out.items).toEqual([]);
    expect(out.ai_request_id).toBe('');
    expect(out.target_role).toBe('backend_developer');
  });

  it('forwards lang override to getGapReport and phrasePlan', async () => {
    const { service, interviewPlan } = build();
    jest.spyOn(service, 'getGapReport').mockResolvedValue(
      report({
        gap_items: [gap({ canonical_name: 'react', cv_status: 'missing', importance: 'REQUIRED' })],
      }),
    );

    await service.generateInterviewPlanFromMatch('user-1', 'match-1', { lang: 'en' });

    expect(service.getGapReport).toHaveBeenCalledWith('user-1', 'match-1', 'en');
    expect(interviewPlan.phrasePlan.mock.calls[0][3]).toBe('en');
  });

  it('propagates ownership/not-found rejection from getGapReport (no phrasePlan call)', async () => {
    const { service, interviewPlan } = build();
    jest.spyOn(service, 'getGapReport').mockRejectedValue(new NotFoundException());

    await expect(
      service.generateInterviewPlanFromMatch('user-1', 'nope', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(interviewPlan.phrasePlan).not.toHaveBeenCalled();
  });
});
