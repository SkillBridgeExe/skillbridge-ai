import { buildUnifiedPlan } from '../../../src/modules/gap-report/unified-plan';
import { GapItem } from '../../../src/modules/gap-engine/gap-item';
import { InterviewGapItem } from '../../../src/modules/interview/interview-gap';

const gap = (over: Partial<GapItem>): GapItem =>
  ({
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
    ...over,
  }) as GapItem;

const interviewGap = (over: Partial<InterviewGapItem>): InterviewGapItem => ({
  requirement_id: null,
  target_type: 'skill',
  skill_canonical: 'react',
  display_name: 'React',
  weakness_type: 'knowledge_gap',
  severity: 0.6,
  evidence_from_answer: '',
  recommended_action: '',
  linked_question_id: null,
  ...over,
});

describe('buildUnifiedPlan', () => {
  it('routes gap fixability into learn and cv_fix tracks and excludes not_fixable_now', () => {
    const out = buildUnifiedPlan({
      matchId: 'm1',
      sessionId: null,
      gapItems: [
        gap({ canonical_name: 'react', fixability: 'learn' }),
        gap({ canonical_name: 'sql', display_name: 'SQL', fixability: 'add_evidence' }),
        gap({ canonical_name: 'x', fixability: 'not_fixable_now' }),
      ],
      interviewItems: [],
    });

    expect(out.learn_items.map((item) => item.skill_canonical)).toEqual(['react']);
    expect(out.cv_fix_items.map((item) => item.skill_canonical)).toEqual(['sql']);
    expect(out.interview_practice_items).toEqual([]);
  });

  it('does not route non-course-addressable learn gaps into learning items', () => {
    const out = buildUnifiedPlan({
      matchId: 'm1',
      sessionId: null,
      gapItems: [
        gap({
          type: 'seniority',
          canonical_name: 'seniority',
          display_name: 'Cấp độ / kinh nghiệm',
          fixability: 'learn',
        }),
        gap({
          type: 'language',
          canonical_name: 'language',
          display_name: 'English',
          fixability: 'learn',
        }),
      ],
      interviewItems: [],
    });

    expect(out.learn_items.map((item) => item.skill_canonical)).toEqual([
      'english_proficiency',
    ]);
  });

  it('routes interview weakness_type into tracks', () => {
    const out = buildUnifiedPlan({
      matchId: 'm1',
      sessionId: 's1',
      gapItems: [],
      interviewItems: [
        interviewGap({ skill_canonical: 'go', display_name: 'Go', weakness_type: 'knowledge_gap' }),
        interviewGap({
          skill_canonical: 'docs',
          display_name: 'Docs',
          weakness_type: 'evidence_gap',
          target_type: 'evidence',
        }),
        interviewGap({
          skill_canonical: null,
          display_name: 'STAR',
          weakness_type: 'behavioral_gap',
          target_type: 'behavioral',
        }),
      ],
    });

    expect(out.learn_items.map((item) => item.display_name)).toEqual(['Go']);
    expect(out.cv_fix_items.map((item) => item.display_name)).toEqual(['Docs']);
    expect(out.interview_practice_items.map((item) => item.display_name)).toEqual(['STAR']);
  });

  it('dedups within a track and boosts priority when source is both', () => {
    const out = buildUnifiedPlan({
      matchId: 'm1',
      sessionId: 's1',
      gapItems: [gap({ canonical_name: 'react', fixability: 'learn', severity: 0.5 })],
      interviewItems: [interviewGap({ skill_canonical: 'react', severity: 0.5 })],
    });
    const gapOnly = buildUnifiedPlan({
      matchId: 'm1',
      sessionId: null,
      gapItems: [gap({ severity: 0.5 })],
      interviewItems: [],
    });

    expect(out.learn_items).toHaveLength(1);
    expect(out.learn_items[0].source).toBe('both');
    expect(out.learn_items[0].priority).toBeGreaterThan(gapOnly.learn_items[0].priority);
  });

  it('sorts each track by priority descending', () => {
    const out = buildUnifiedPlan({
      matchId: 'm1',
      sessionId: null,
      gapItems: [
        gap({
          canonical_name: 'low',
          display_name: 'Low',
          importance: 'NICE_TO_HAVE',
          severity: 0.3,
        }),
        gap({
          canonical_name: 'high',
          display_name: 'High',
          importance: 'REQUIRED',
          severity: 0.9,
        }),
      ],
      interviewItems: [],
    });

    expect(out.learn_items.map((item) => item.skill_canonical)).toEqual(['high', 'low']);
  });
});
