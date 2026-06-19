import { BadRequestException } from '@nestjs/common';
import { UnifiedPlanService } from '../../../src/platform/cv-matches/unified-plan.service';

describe('UnifiedPlanService.get', () => {
  const cvMatches = {
    getGapReport: jest.fn(),
  };
  const interviewGap = {
    get: jest.fn(),
    getLatestForMatch: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    cvMatches.getGapReport.mockResolvedValue({
      gap_items: [
        {
          requirement_id: 'jd:hard_skill:react',
          source: 'jd',
          type: 'hard_skill',
          canonical_name: 'react',
          display_name: 'React',
          importance: 'REQUIRED',
          cv_status: 'missing',
          cv_level: 0,
          required_level: 4,
          gap_levels: 4,
          satisfied_by: null,
          evidence_refs: [],
          evidence_risk: 'none',
          fixability: 'learn',
          market_demand: null,
          severity: 0.8,
          confidence: 1,
          recommended_next_action: '',
        },
      ],
    });
    interviewGap.get.mockResolvedValue({
      session_id: 's1',
      match_id: 'm1',
      gap_items: [
        {
          requirement_id: null,
          target_type: 'communication',
          skill_canonical: null,
          display_name: 'Clarity',
          weakness_type: 'communication_gap',
          severity: 0.6,
          evidence_from_answer: '',
          recommended_action: '',
          linked_question_id: null,
        },
      ],
    });
    interviewGap.getLatestForMatch.mockResolvedValue({
      session_id: 's-latest',
      match_id: 'm1',
      gap_items: [
        {
          requirement_id: null,
          target_type: 'communication',
          skill_canonical: null,
          display_name: 'Clarity',
          weakness_type: 'communication_gap',
          severity: 0.6,
          evidence_from_answer: '',
          recommended_action: '',
          linked_question_id: null,
        },
      ],
    });
  });

  it('merges the gap report and the given interview session into a unified plan', async () => {
    const svc = new UnifiedPlanService(cvMatches as never, interviewGap as never);

    const out = await svc.get('u1', 'm1', 's1');

    expect(out.match_id).toBe('m1');
    expect(out.session_id).toBe('s1');
    expect(out.learn_items.map((item) => item.skill_canonical)).toEqual(['react']);
    expect(out.interview_practice_items.map((item) => item.display_name)).toEqual(['Clarity']);
    expect(interviewGap.get).toHaveBeenCalledWith('u1', 's1');
  });

  it('rejects an explicit interview session from a different match', async () => {
    interviewGap.get.mockResolvedValueOnce({
      match_id: 'other-match',
      gap_items: [],
    });
    const svc = new UnifiedPlanService(cvMatches as never, interviewGap as never);

    await expect(svc.get('u1', 'm1', 's-other')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses the latest completed interview for the match when no sessionId is given', async () => {
    const svc = new UnifiedPlanService(cvMatches as never, interviewGap as never);

    const out = await svc.get('u1', 'm1');

    expect(out.session_id).toBe('s-latest');
    expect(out.interview_practice_items.map((item) => item.display_name)).toEqual(['Clarity']);
    expect(interviewGap.getLatestForMatch).toHaveBeenCalledWith('u1', 'm1');
    expect(interviewGap.get).not.toHaveBeenCalled();
  });

  it('returns a gap-only plan when no sessionId is given and no completed interview exists', async () => {
    interviewGap.getLatestForMatch.mockResolvedValueOnce(null);
    const svc = new UnifiedPlanService(cvMatches as never, interviewGap as never);

    const out = await svc.get('u1', 'm1');

    expect(out.session_id).toBeNull();
    expect(out.interview_practice_items).toEqual([]);
    expect(interviewGap.getLatestForMatch).toHaveBeenCalledWith('u1', 'm1');
  });
});
