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
