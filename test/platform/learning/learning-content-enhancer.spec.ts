import { LearningContentEnhancer } from '../../../src/platform/learning/learning-content-enhancer';

const preview = () =>
  ({
    roadmap_id: 'roadmap-1',
    revision: 1,
    target_role: 'frontend_developer',
    summary: 'Plan',
    learning_track: 'FAST_TRACK',
    content_source: 'DETERMINISTIC',
    capacity_minutes: 60,
    scheduled_minutes: 40,
    coverage_percentage: 80,
    modules: [
      {
        skill_canonical: 'typescript',
        display_name: 'TypeScript',
        rank: 1,
        estimated_minutes: 40,
        feasibility: 'FEASIBLE',
        resources: [],
        lesson_content: null,
        quick_win_score: 90,
        scope_status: 'FULL',
        prerequisite_warnings: [],
        lessons: [
          {
            id: 'typescript:section:types',
            title: 'Types',
            summary: 'Original summary',
            key_points: ['Original point'],
            estimated_minutes: 20,
            importance: 'CORE',
            kind: 'LEARN',
            scope_status: 'INCLUDED',
            content_source: 'DETERMINISTIC',
          },
        ],
      },
    ],
    sessions: [],
    deferred: [],
  }) as const;

describe('LearningContentEnhancer', () => {
  it('enhances only presentation fields with one bounded structured call', async () => {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: {
          lessons: [
            {
              id: 'typescript:section:types',
              title: 'TypeScript types cấp tốc',
              summary: 'Nắm kiểu dữ liệu tại boundary.',
              key_points: ['Khai báo kiểu rõ ràng'],
            },
          ],
        },
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({ meta: { system: 'system' } }),
      render: jest.fn().mockReturnValue('prompt'),
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'learning.contentAiEnabled'
          ? true
          : key === 'learning.contentAiModel'
            ? 'gpt-4.1-mini'
            : undefined,
      ),
    };
    const service = new LearningContentEnhancer(llm as never, prompts as never, config as never);

    const result = await service.enhance(preview() as never);

    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(llm.complete).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        jsonMode: true,
        timeoutMs: 8_000,
        maxRetries: 0,
      }),
    );
    expect(result.content_source).toBe('AI_ENHANCED');
    expect(result.modules[0].lessons[0]).toEqual(
      expect.objectContaining({
        title: 'TypeScript types cấp tốc',
        estimated_minutes: 20,
        scope_status: 'INCLUDED',
        content_source: 'AI_ENHANCED',
      }),
    );
  });

  it.each([
    ['provider error', new Error('timeout')],
    ['invalid schema', { parsedJson: { lessons: [{ id: 'unknown' }] } }],
  ])('degrades to deterministic fallback on %s', async (_name, outcome) => {
    const complete =
      outcome instanceof Error
        ? jest.fn().mockRejectedValue(outcome)
        : jest.fn().mockResolvedValue(outcome);
    const service = new LearningContentEnhancer(
      { complete } as never,
      {
        get: jest.fn().mockReturnValue({ meta: { system: 'system' } }),
        render: jest.fn().mockReturnValue('prompt'),
      } as never,
      {
        get: jest.fn((key: string) =>
          key === 'learning.contentAiEnabled'
            ? true
            : key === 'learning.contentAiModel'
              ? 'gpt-4.1-mini'
              : undefined,
        ),
      } as never,
    );

    const result = await service.enhance(preview() as never);

    expect(result.content_source).toBe('DETERMINISTIC_FALLBACK');
    expect(result.modules[0].lessons[0].summary).toBe('Original summary');
    expect(result.modules[0].lessons[0].content_source).toBe('DETERMINISTIC_FALLBACK');
  });

  it('falls back per module when one AI materialization fails', async () => {
    const first = preview();
    const second = JSON.parse(JSON.stringify(first));
    second.modules[0].skill_canonical = 'react';
    second.modules[0].lessons[0].id = 'react:section:types';
    const input = {
      ...first,
      modules: [first.modules[0], second.modules[0]],
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce({
        parsedJson: {
          lessons: [
            {
              id: 'typescript:section:types',
              title: 'Enhanced TypeScript',
              summary: 'Enhanced summary',
              key_points: ['Enhanced point'],
            },
          ],
        },
      })
      .mockRejectedValueOnce(new Error('module timeout'));
    const service = new LearningContentEnhancer(
      { complete } as never,
      {
        get: jest.fn().mockReturnValue({ meta: { system: 'system' } }),
        render: jest.fn().mockReturnValue('prompt'),
      } as never,
      {
        get: jest.fn((key: string) =>
          key === 'learning.contentAiEnabled'
            ? true
            : key === 'learning.contentAiModel'
              ? 'gpt-4.1-mini'
              : undefined,
        ),
      } as never,
    );

    const result = await service.enhance(input as never);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.content_source).toBe('DETERMINISTIC_FALLBACK');
    expect(result.modules[0].lessons[0].content_source).toBe('AI_ENHANCED');
    expect(result.modules[1].lessons[0].content_source).toBe('DETERMINISTIC_FALLBACK');
  });
  it('materializes enhanced presentation fields into persisted lesson content', async () => {
    const input = JSON.parse(JSON.stringify(preview())) as {
      modules: Array<{
        lesson_content: Record<string, unknown> | null;
        lessons: Array<Record<string, unknown>>;
      }>;
    };
    input.modules[0].lesson_content = {
      skill_canonical: 'typescript',
      title: 'Original lesson',
      summary: 'Original lesson summary',
      license_type: 'skillbridge_original',
      reuse_policy: 'full_reuse_allowed',
      source_resource_ids: [],
      learning_objectives: [{ id: 'types', title: 'Types', description: 'Use types.' }],
      sections: [
        {
          id: 'types',
          title: 'Original section',
          body: 'Original body',
          objective_id: 'types',
          checklist: [{ id: 'check', label: 'Original checklist' }],
        },
      ],
      quiz_bank: [],
      pass_policy: { min_correct_per_objective: 1, min_accuracy: 0.7 },
      quiz: [],
      exercises: [
        {
          id: 'practice',
          title: 'Original exercise',
          prompt: 'Original prompt',
          acceptance_criteria: ['Original criterion'],
          proof_of_completion: 'Save proof.',
        },
      ],
    };
    input.modules[0].lessons.push({
      id: 'typescript:exercise:practice',
      title: 'Practice',
      summary: 'Original exercise summary',
      key_points: ['Original criterion'],
      estimated_minutes: 20,
      importance: 'CORE',
      kind: 'PRACTICE',
      scope_status: 'INCLUDED',
      content_source: 'DETERMINISTIC',
    });

    const service = new LearningContentEnhancer(
      {
        complete: jest.fn().mockResolvedValue({
          parsedJson: {
            lessons: [
              {
                id: 'typescript:section:types',
                title: 'Enhanced section',
                summary: 'Enhanced body',
                key_points: ['Enhanced checklist'],
              },
              {
                id: 'typescript:exercise:practice',
                title: 'Enhanced exercise',
                summary: 'Enhanced prompt',
                key_points: ['Enhanced criterion'],
              },
            ],
          },
        }),
      } as never,
      {
        get: jest.fn().mockReturnValue({ meta: { system: 'system' } }),
        render: jest.fn().mockReturnValue('prompt'),
      } as never,
      {
        get: jest.fn((key: string) =>
          key === 'learning.contentAiEnabled'
            ? true
            : key === 'learning.contentAiModel'
              ? 'gpt-4.1-mini'
              : undefined,
        ),
      } as never,
    );

    const result = await service.enhance(input as never);
    const content = result.modules[0].lesson_content as unknown as {
      sections: Array<{ title: string; body: string; checklist: Array<{ label: string }> }>;
      exercises: Array<{ title: string; prompt: string; acceptance_criteria: string[] }>;
    };

    expect(content.sections[0]).toEqual(
      expect.objectContaining({
        title: 'Enhanced section',
        body: 'Enhanced body',
        checklist: [{ id: 'check', label: 'Enhanced checklist' }],
      }),
    );
    expect(content.exercises[0]).toEqual(
      expect.objectContaining({
        title: 'Enhanced exercise',
        prompt: 'Enhanced prompt',
        acceptance_criteria: ['Enhanced criterion'],
      }),
    );
  });

  it('keeps malformed persisted lesson content unchanged during enhancement', async () => {
    const input = JSON.parse(JSON.stringify(preview())) as {
      modules: Array<{ lesson_content: Record<string, unknown> | null }>;
    };
    const malformed = { skill_canonical: 'typescript', sections: 'invalid', exercises: [] };
    input.modules[0].lesson_content = malformed;

    const service = new LearningContentEnhancer(
      {
        complete: jest.fn().mockResolvedValue({
          parsedJson: {
            lessons: [
              {
                id: 'typescript:section:types',
                title: 'Enhanced',
                summary: 'Enhanced',
                key_points: ['Point'],
              },
            ],
          },
        }),
      } as never,
      {
        get: jest.fn().mockReturnValue({ meta: { system: 'system' } }),
        render: jest.fn().mockReturnValue('prompt'),
      } as never,
      {
        get: jest.fn((key: string) =>
          key === 'learning.contentAiEnabled'
            ? true
            : key === 'learning.contentAiModel'
              ? 'gpt-4.1-mini'
              : undefined,
        ),
      } as never,
    );

    const result = await service.enhance(input as never);

    expect(result.modules[0].lesson_content).toEqual(malformed);
  });
  it('returns deterministic content without calling dependencies when AI enhancement is disabled', async () => {
    const llm = { complete: jest.fn() };
    const prompts = { get: jest.fn(), render: jest.fn() };
    const service = new LearningContentEnhancer(
      llm as never,
      prompts as never,
      {
        get: jest.fn((key: string) => (key === 'learning.contentAiEnabled' ? false : undefined)),
      } as never,
    );
    const original = preview();

    const result = await service.enhance(original as never);

    expect(result).toBe(original);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(prompts.get).not.toHaveBeenCalled();
    expect(prompts.render).not.toHaveBeenCalled();
  });
});
