import {
  buildLearningContentPlan,
  estimateSectionMinutes,
} from '../../../src/platform/learning/learning-content-planner';

const lesson = (skill: string, sectionCount: number) => ({
  skill_canonical: skill,
  title: skill,
  summary: `Learn ${skill}`,
  license_type: 'skillbridge_original' as const,
  reuse_policy: 'full_reuse_allowed' as const,
  source_resource_ids: [],
  learning_objectives: Array.from({ length: sectionCount }, (_, index) => ({
    id: `objective-${index + 1}`,
    title: `Objective ${index + 1}`,
    description: `Objective ${index + 1}`,
  })),
  sections: Array.from({ length: sectionCount }, (_, index) => ({
    id: `section-${index + 1}`,
    title: `Section ${index + 1}`,
    body: 'A focused explanation with enough detail for a short learning unit.',
    objective_id: `objective-${index + 1}`,
    checklist: [{ id: `check-${index + 1}`, label: 'Apply the concept once' }],
  })),
  quiz_bank: [],
  pass_policy: { min_correct_per_objective: 1, min_accuracy: 0.7 },
  quiz: [],
  exercises: [
    {
      id: `exercise-${skill}`,
      title: `Practice ${skill}`,
      prompt: `Practice ${skill}`,
      acceptance_criteria: ['Working result', 'Saved proof'],
      proof_of_completion: 'Save proof',
    },
  ],
});

describe('buildLearningContentPlan', () => {
  it('estimates atomic sections in bounded five-minute learning units', () => {
    expect(
      estimateSectionMinutes({
        id: 'section',
        title: 'Section',
        body: 'word '.repeat(700),
        objective_id: 'objective',
        checklist: Array.from({ length: 10 }, (_, index) => ({
          id: String(index),
          label: 'Check',
        })),
      }),
    ).toBe(25);
  });

  it('prioritizes a high-impact quick win and never exceeds FAST_TRACK capacity', () => {
    const result = buildLearningContentPlan({
      track: 'FAST_TRACK',
      capacityMinutes: 60,
      candidates: [
        {
          skillCanonical: 'complex',
          displayName: 'Complex',
          systemPriority: 1,
          userRank: 2,
          prerequisites: ['foundation'],
          lessonContent: lesson('complex', 5),
        },
        {
          skillCanonical: 'quick',
          displayName: 'Quick',
          systemPriority: 0.9,
          userRank: 1,
          prerequisites: [],
          lessonContent: lesson('quick', 1),
        },
      ],
    });

    expect(result.scheduledMinutes).toBeLessThanOrEqual(60);
    expect(result.modules[0]).toEqual(
      expect.objectContaining({
        skillCanonical: 'quick',
        scopeStatus: 'FULL',
      }),
    );
    expect(result.modules.find((module) => module.skillCanonical === 'complex')).toEqual(
      expect.objectContaining({ scopeStatus: 'DEFERRED' }),
    );
  });

  it('keeps foundation prerequisite ordering and exposes omitted lesson reasons', () => {
    const result = buildLearningContentPlan({
      track: 'FOUNDATION',
      capacityMinutes: 60,
      candidates: [
        {
          skillCanonical: 'advanced',
          displayName: 'Advanced',
          systemPriority: 1,
          userRank: 1,
          prerequisites: ['base'],
          lessonContent: lesson('advanced', 1),
        },
        {
          skillCanonical: 'base',
          displayName: 'Base',
          systemPriority: 0.7,
          userRank: 2,
          prerequisites: [],
          lessonContent: lesson('base', 1),
        },
      ],
    });

    expect(result.modules.map((module) => module.skillCanonical)).toEqual(['base', 'advanced']);
    expect(result.modules[1].lessons.every((item) => item.scopeStatus === 'OMITTED')).toBe(true);
    expect(result.modules[1].lessons[0].omissionReason).toBe('TIME_LIMIT');
  });

  it('keeps a selected skill with no catalog lesson by creating a stable skeleton', () => {
    const result = buildLearningContentPlan({
      track: 'FOUNDATION',
      candidates: [
        {
          skillCanonical: 'uncatalogued_skill',
          displayName: 'Uncatalogued Skill',
          systemPriority: 1,
          userRank: 1,
          prerequisites: [],
        },
      ],
    });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]).toEqual(
      expect.objectContaining({
        skillCanonical: 'uncatalogued_skill',
        scopeStatus: 'FULL',
        scheduledMinutes: expect.any(Number),
      }),
    );
    expect(result.modules[0].lessons.length).toBeGreaterThanOrEqual(3);
    expect(
      result.modules[0].lessons.every((lesson) => lesson.id.startsWith('uncatalogued_skill:')),
    ).toBe(true);
  });
  it('uses goal-defined scope when no deadline capacity is supplied', () => {
    const candidates = [
      {
        skillCanonical: 'typescript',
        displayName: 'TypeScript',
        systemPriority: 1,
        userRank: 1,
        prerequisites: [],
        lessonContent: lesson('typescript', 3),
      },
    ];

    const fastTrack = buildLearningContentPlan({
      track: 'FAST_TRACK',
      candidates,
    });
    const foundation = buildLearningContentPlan({
      track: 'FOUNDATION',
      candidates,
    });

    expect(fastTrack.modules[0].scopeStatus).toBe('CORE_ONLY');
    expect(fastTrack.modules[0].lessons.filter((item) => item.scopeStatus === 'INCLUDED')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ importance: 'CORE', kind: 'LEARN' }),
        expect.objectContaining({ importance: 'CORE', kind: 'PRACTICE' }),
      ]),
    );
    expect(fastTrack.modules[0].lessons.filter((item) => item.scopeStatus === 'OMITTED')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ importance: 'EXTENSION', omissionReason: 'LOWER_PRIORITY' }),
      ]),
    );
    expect(foundation.modules[0].scopeStatus).toBe('FULL');
    expect(foundation.coveragePercentage).toBe(100);
  });
});
