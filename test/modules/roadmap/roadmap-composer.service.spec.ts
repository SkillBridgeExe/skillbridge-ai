import { GapItem } from '../../../src/modules/gap-engine/gap-item';
import { UnifiedDevelopmentPlanItem } from '../../../src/modules/gap-report/unified-plan';
import { RoadmapComposerService } from '../../../src/modules/roadmap/roadmap-composer.service';

const matcher = {
  matchResources: jest.fn().mockReturnValue({
    per_skill: [
      {
        skill_canonical_name: 'react',
        required_level: 4,
        resources: [
          {
            id: 'r1',
            source_type: 'course',
            title: 'React',
            url: 'https://u',
            is_internal: false,
            outcome_type: 'understand',
            proof_of_completion: 'cert',
            match_score: 90,
            quality_score: 92,
            freshness_score: 100,
          },
        ],
      },
    ],
    uncovered_skills: [],
  }),
};

const learn = (skill: string, severity: number): UnifiedDevelopmentPlanItem => ({
  source: 'gap',
  track: 'learn',
  skill_canonical: skill,
  display_name: skill,
  priority: severity,
  severity,
  rationale: '',
  requirement_id: `jd:hard_skill:${skill}`,
});

const gap = (skill: string): GapItem =>
  ({
    requirement_id: `jd:hard_skill:${skill}`,
    source: 'jd',
    type: 'hard_skill',
    canonical_name: skill,
    display_name: skill,
    importance: 'REQUIRED',
    cv_status: 'partial',
    cv_level: 2,
    required_level: 4,
    gap_levels: 2,
    satisfied_by: null,
    evidence_refs: [],
    evidence_risk: 'none',
    fixability: 'learn',
    market_demand: 50,
    severity: 0.8,
    confidence: 1,
    recommended_next_action: '',
  }) as GapItem;

describe('RoadmapComposerService.compose', () => {
  beforeEach(() => matcher.matchResources.mockClear());

  it('attaches curated resources to feasible steps and lists not_feasible honestly', () => {
    const svc = new RoadmapComposerService(matcher as never);
    const out = svc.compose({
      learnItems: [learn('react', 0.9), learn('rust', 0.4)],
      gapItems: [gap('react'), gap('rust')],
      budget: { available_days: 30, hours_per_week: 7 },
    });

    expect(out.steps[0].skill_canonical).toBe('react');
    expect(out.steps[0].resources[0].id).toBe('r1');
    expect(out.not_feasible_items.map((item) => item.skill_canonical)).toContain('rust');
    expect(out.ai_summary.length).toBeGreaterThan(0);
    expect(matcher.matchResources).toHaveBeenCalledWith(
      [{ skill_canonical_name: 'react', required_level: 4 }],
      { sourceTypes: ['course', 'official_doc', 'video', 'exercise', 'mini_project'] },
    );
  });
});
