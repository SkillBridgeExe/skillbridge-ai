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
            provider: 'Coursera',
            url: 'https://u',
            is_internal: false,
            content_template_id: 'skillbridge.react.l4.project',
            description: 'Build a SkillBridge-owned React portfolio project.',
            language: 'vi',
            duration_minutes: 60,
            difficulty: 'INTERMEDIATE',
            is_free: true,
            skills: [{ skill_canonical_name: 'react', teaches_level: 4 }],
            outcome_type: 'understand',
            proof_of_completion: 'cert',
            match_score: 90,
            match_breakdown: {
              quality_pts: 28,
              language_pts: 20,
              free_pts: 15,
              level_fit_pts: 20,
              multi_skill_pts: 7,
            },
            quality_score: 92,
            freshness_score: 100,
            low_confidence: true,
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

const gap = (skill: string, over: Partial<GapItem> = {}): GapItem =>
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
    ...over,
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
    expect(out.steps[0].lesson_content).toMatchObject({
      skill_canonical: 'react',
      license_type: 'skillbridge_original',
      reuse_policy: 'full_reuse_allowed',
    });
    expect(out.steps[0].lesson_content?.sections.length).toBeGreaterThan(0);
    expect(out.steps[0].lesson_content?.quiz.length).toBeGreaterThan(0);
    expect(out.steps[0].lesson_content?.exercises.length).toBeGreaterThan(0);
    expect(out.steps[0].resources[0].id).toBe('r1');
    expect(out.steps[0].resources[0]).toMatchObject({
      content_template_id: 'skillbridge.react.l4.project',
      description: 'Build a SkillBridge-owned React portfolio project.',
    });
    expect(out.steps[0].resources[0].low_confidence).toBe(true);
    expect(out.steps[0].recommended_courses?.map((course) => course.id)).toEqual(['r1']);
    expect(out.steps.map((item) => item.skill_canonical)).toContain('rust');
    expect(out.not_feasible_items).toEqual([]);
    expect(out.ai_summary.length).toBeGreaterThan(0);
    expect(matcher.matchResources).toHaveBeenCalledWith(
      [
        { skill_canonical_name: 'react', required_level: 4 },
        { skill_canonical_name: 'rust', required_level: 4 },
      ],
      {
        sourceTypes: ['course', 'official_doc', 'video', 'exercise', 'mini_project'],
        langPref: 'both',
      },
    );
  });

  it('passes the requested language preference into resource matching', () => {
    const svc = new RoadmapComposerService(matcher as never);
    svc.compose({
      learnItems: [learn('react', 0.9)],
      gapItems: [gap('react')],
      budget: { available_days: 30, hours_per_week: 7 },
      languagePref: 'en',
    });

    expect(matcher.matchResources).toHaveBeenCalledWith(
      [{ skill_canonical_name: 'react', required_level: 4 }],
      {
        sourceTypes: ['course', 'official_doc', 'video', 'exercise', 'mini_project'],
        langPref: 'en',
      },
    );
  });

  it('uses the primary matched resource duration as feasibility floor before selecting steps', () => {
    matcher.matchResources.mockReturnValueOnce({
      per_skill: [
        {
          skill_canonical_name: 'react',
          required_level: 3,
          resources: [
            {
              id: 'long-react',
              source_type: 'course',
              title: 'Long React',
              provider: 'Coursera',
              url: 'https://u',
              is_internal: false,
              language: 'vi',
              duration_minutes: 1800,
              difficulty: 'INTERMEDIATE',
              is_free: true,
              skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
              outcome_type: 'understand',
              proof_of_completion: 'cert',
              match_score: 95,
              match_breakdown: {
                quality_pts: 28,
                language_pts: 20,
                free_pts: 15,
                level_fit_pts: 20,
                multi_skill_pts: 12,
              },
              quality_score: 92,
              freshness_score: 100,
              low_confidence: false,
            },
            {
              id: 'short-react',
              source_type: 'video',
              title: 'Short React',
              provider: 'YouTube',
              url: 'https://u',
              is_internal: false,
              language: 'vi',
              duration_minutes: 60,
              difficulty: 'BEGINNER',
              is_free: true,
              skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
              outcome_type: 'understand',
              match_score: 60,
              match_breakdown: {
                quality_pts: 12,
                language_pts: 20,
                free_pts: 15,
                level_fit_pts: 10,
                multi_skill_pts: 3,
              },
              quality_score: 40,
              freshness_score: 100,
              low_confidence: true,
            },
          ],
        },
      ],
      uncovered_skills: [],
    });

    const svc = new RoadmapComposerService(matcher as never);
    const out = svc.compose({
      learnItems: [learn('react', 0.9)],
      gapItems: [gap('react', { required_level: 3, cv_level: 2 })],
      budget: { available_days: 14, hours_per_week: 10 },
    });

    expect(out.steps.map((s) => s.skill_canonical)).toEqual(['react']);
    expect(out.steps[0].estimated_hours).toBe(30);
    expect(out.not_feasible_items).toEqual([]);
  });

  it('puts all items in steps even with extremely limited budget', () => {
    matcher.matchResources.mockReturnValueOnce({
      per_skill: [],
      uncovered_skills: [],
    });

    const svc = new RoadmapComposerService(matcher as never);
    const out = svc.compose({
      learnItems: [{ ...learn('communication', 0.9), source: 'both' }, learn('portfolio', 0.8)],
      gapItems: [
        gap('communication', { evidence_risk: 'none', required_level: 5, cv_level: 0 }),
        gap('portfolio', { evidence_risk: 'unproven', required_level: 5, cv_level: 0 }),
      ],
      budget: { available_days: 1, hours_per_week: 1 },
    });

    expect(out.steps.map((s) => s.skill_canonical)).toEqual(['communication', 'portfolio']);
    expect(out.not_feasible_items).toEqual([]);
  });
});
