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

  it('attaches curated resources and schedules every selected skill', async () => {
    const svc = new RoadmapComposerService(matcher as never);
    const out = await svc.compose({
      learnItems: [learn('react', 0.9), learn('rust', 0.4)],
      gapItems: [gap('react'), gap('rust')],
      budget: { available_days: 30, hours_per_week: 7 },
    });

    expect(out.steps[0].skill_canonical).toBe('react');
    expect(out.steps[0].strategy).toBe('deep_build');
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
    expect(out.sessions?.map((session) => session.primary_skill)).toEqual(
      expect.arrayContaining(['react', 'rust']),
    );
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
        preferLanguageIfAvailable: false,
      },
    );
  });

  it('passes the requested language preference into resource matching', async () => {
    const svc = new RoadmapComposerService(matcher as never);
    await svc.compose({
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
        preferLanguageIfAvailable: true,
      },
    );
  });

  it('does not let recommended course payload grow past 30 courses per step', async () => {
    matcher.matchResources.mockReturnValueOnce({
      per_skill: [
        {
          skill_canonical_name: 'react',
          required_level: 4,
          resources: Array.from({ length: 35 }, (_, index) => ({
            id: `react-${index + 1}`,
            source_type: 'course',
            title: `React ${index + 1}`,
            provider: 'Coursera',
            url: 'https://u',
            is_internal: false,
            language: 'vi',
            duration_minutes: 60,
            difficulty: 'INTERMEDIATE',
            is_free: true,
            skills: [{ skill_canonical_name: 'react', teaches_level: 4 }],
            outcome_type: 'understand',
            proof_of_completion: 'cert',
            match_score: 100 - index,
            match_breakdown: {
              quality_pts: 28,
              language_pts: 20,
              free_pts: 15,
              level_fit_pts: 20,
              multi_skill_pts: 7,
            },
            quality_score: 92,
            freshness_score: 100,
            low_confidence: false,
          })),
        },
      ],
      uncovered_skills: [],
    });

    const svc = new RoadmapComposerService(matcher as never);
    const out = await svc.compose({
      learnItems: [learn('react', 0.9)],
      gapItems: [gap('react')],
      budget: { available_days: 30, hours_per_week: 7 },
    });

    expect(out.steps[0].recommended_courses).toHaveLength(30);
    expect(out.steps[0].recommended_courses?.at(-1)?.id).toBe('react-30');
  });

  it('keeps only one primary video resource per skill step', async () => {
    matcher.matchResources.mockReturnValueOnce({
      per_skill: [
        {
          skill_canonical_name: 'react',
          required_level: 4,
          resources: [
            {
              id: 'react-video-best',
              source_type: 'video',
              title: 'Best React Video',
              provider: 'YouTube',
              url: 'https://u/best',
              is_internal: false,
              language: 'en',
              duration_minutes: 80,
              difficulty: 'BEGINNER',
              is_free: true,
              skills: [{ skill_canonical_name: 'react', teaches_level: 4 }],
              outcome_type: 'understand',
              match_score: 95,
              match_breakdown: {
                quality_pts: 30,
                language_pts: 20,
                free_pts: 15,
                level_fit_pts: 20,
                multi_skill_pts: 10,
              },
              quality_score: 100,
              freshness_score: 100,
              low_confidence: false,
            },
            {
              id: 'react-video-second',
              source_type: 'video',
              title: 'Second React Video',
              provider: 'YouTube',
              url: 'https://u/second',
              is_internal: false,
              language: 'en',
              duration_minutes: 90,
              difficulty: 'BEGINNER',
              is_free: true,
              skills: [{ skill_canonical_name: 'react', teaches_level: 4 }],
              outcome_type: 'understand',
              match_score: 90,
              match_breakdown: {
                quality_pts: 25,
                language_pts: 20,
                free_pts: 15,
                level_fit_pts: 20,
                multi_skill_pts: 10,
              },
              quality_score: 92,
              freshness_score: 100,
              low_confidence: false,
            },
            {
              id: 'react-course',
              source_type: 'course',
              title: 'React Course',
              provider: 'Coursera',
              url: 'https://u/course',
              is_internal: false,
              language: 'en',
              duration_minutes: 180,
              difficulty: 'INTERMEDIATE',
              is_free: true,
              skills: [{ skill_canonical_name: 'react', teaches_level: 4 }],
              outcome_type: 'practice',
              proof_of_completion: 'cert',
              match_score: 80,
              match_breakdown: {
                quality_pts: 20,
                language_pts: 20,
                free_pts: 15,
                level_fit_pts: 20,
                multi_skill_pts: 5,
              },
              quality_score: 80,
              freshness_score: 100,
              low_confidence: false,
            },
          ],
        },
      ],
      uncovered_skills: [],
    });

    const svc = new RoadmapComposerService(matcher as never);
    const out = await svc.compose({
      learnItems: [learn('react', 0.9)],
      gapItems: [gap('react')],
      budget: { available_days: 30, hours_per_week: 7 },
    });

    expect(out.steps[0].resources.filter((resource) => resource.source_type === 'video')).toEqual([
      expect.objectContaining({ id: 'react-video-best' }),
    ]);
    expect(out.steps[0].resources.map((resource) => resource.id)).toContain('react-course');
  });

  it('uses the primary matched resource duration as feasibility floor before selecting steps', async () => {
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
    const out = await svc.compose({
      learnItems: [learn('react', 0.9)],
      gapItems: [gap('react', { required_level: 3, cv_level: 2 })],
      budget: { available_days: 30, hours_per_week: 10 },
    });

    expect(out.steps.map((s) => s.skill_canonical)).toEqual(['react']);
    expect(out.steps[0].estimated_hours).toBe(30);
    expect(out.not_feasible_items).toEqual([]);
  });

  it('keeps selected items schedulable regardless of the total budget estimate', async () => {
    matcher.matchResources.mockReturnValueOnce({
      per_skill: [],
      uncovered_skills: [],
    });

    const svc = new RoadmapComposerService(matcher as never);
    const out = await svc.compose({
      learnItems: [{ ...learn('communication', 0.9), source: 'both' }, learn('portfolio', 0.8)],
      gapItems: [
        gap('communication', { evidence_risk: 'none', required_level: 5, cv_level: 0 }),
        gap('portfolio', { evidence_risk: 'unproven', required_level: 5, cv_level: 0 }),
      ],
      budget: { available_days: 1, hours_per_week: 1 },
    });

    expect(out.steps.map((step) => step.skill_canonical)).toEqual(['communication', 'portfolio']);
    expect(out.sessions?.map((session) => session.primary_skill)).toEqual(
      expect.arrayContaining(['communication', 'portfolio']),
    );
    expect(out.not_feasible_items).toEqual([]);
    expect(out.ai_summary).toContain('Focus on 2 selected skills');
  });

  it('keeps the user-selected skill order when scheduling parallel lanes', async () => {
    matcher.matchResources.mockReturnValueOnce({
      per_skill: [],
      uncovered_skills: [],
    });

    const svc = new RoadmapComposerService(matcher as never);
    const out = await svc.compose({
      learnItems: [learn('java', 0.95), learn('swift', 0.2), learn('kotlin', 0.8)],
      gapItems: [gap('java'), gap('swift'), gap('kotlin')],
      budget: {
        minutes_per_session: 120,
        sessions_per_week: 10,
        study_days_per_week: 5,
      },
      selectedSkillOrder: ['swift', 'kotlin', 'java'],
    });

    expect(out.steps.map((step) => step.skill_canonical)).toEqual(['swift', 'kotlin', 'java']);
    expect(out.sessions?.slice(0, 2).map((session) => session.primary_skill)).toEqual([
      'swift',
      'kotlin',
    ]);
  });

  it('keeps every item as a step when the budget is roomy (unchanged happy path)', async () => {
    const svc = new RoadmapComposerService(matcher as never);
    const out = await svc.compose({
      learnItems: [learn('react', 0.9), learn('rust', 0.4)],
      gapItems: [gap('react'), gap('rust')],
      budget: { available_days: 60, hours_per_week: 7 },
    });

    expect(out.steps.map((s) => s.skill_canonical)).toEqual(['react', 'rust']);
    expect(out.steps.map((s) => s.strategy)).toEqual(['deep_build', 'deep_build']);
    expect(out.not_feasible_items).toEqual([]);
  });

  it('keeps the planner strategy on a short timeline', async () => {
    const svc = new RoadmapComposerService(matcher as never);
    const out = await svc.compose({
      learnItems: [learn('react', 0.9)],
      gapItems: [gap('react', { required_level: 3, cv_level: 2 })],
      budget: { available_days: 7, hours_per_week: 20 },
    });

    expect(out.steps.map((s) => s.skill_canonical)).toEqual(['react']);
    expect(out.steps[0].strategy).toBe('crash_prep');
    expect(out.not_feasible_items).toEqual([]);
  });

  it('adds translated display metadata when requested for Vietnamese output', async () => {
    const displayTranslation = {
      translateDisplay: jest.fn(async (input) => ({
        ...input,
        title: 'React da dich',
      })),
    };
    const svc = new RoadmapComposerService(matcher as never, displayTranslation as never);

    const out = await svc.compose({
      learnItems: [learn('react', 0.9)],
      gapItems: [gap('react')],
      budget: { available_days: 30, hours_per_week: 7 },
      languagePref: 'vi',
      translateDisplay: true,
    });

    expect(displayTranslation.translateDisplay).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'vi',
        title: 'react',
      }),
    );
    expect(out.steps[0].translated_display).toMatchObject({ title: 'React da dich' });
  });
});
