import { RoadmapService } from '../../../src/modules/roadmap/roadmap.service';
import { ScoredCourse } from '../../../src/modules/roadmap/course-matcher.service';
import { RoadmapGenerateRequestDto } from '../../../src/modules/roadmap/dto/roadmap-request.dto';

const course = (index: number): ScoredCourse => ({
  id: `react-${index}`,
  title: `React ${index}`,
  url: 'https://example.test/react',
  provider: 'Coursera',
  language: 'vi',
  duration_minutes: 60,
  rating: 4.5,
  is_free: true,
  difficulty: 'INTERMEDIATE',
  skills: [{ skill_canonical_name: 'react', teaches_level: 4 }],
  match_score: 100 - index,
  match_breakdown: {
    rating_pts: 28,
    language_pts: 20,
    free_pts: 15,
    level_fit_pts: 20,
    multi_skill_pts: 7,
  },
});

describe('RoadmapService.generate', () => {
  it('caps aggregated recommended courses before returning and persisting the roadmap', async () => {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: {
          title: 'Roadmap',
          total_weeks: 4,
          phases: [],
          steps: [
            {
              title: 'Learn React',
              description: 'React',
              step_order: 1,
              phase_order: 1,
              estimated_days: 7,
              skill_canonical_names: ['react'],
              learning_objectives: ['Build React apps'],
            },
          ],
          ai_summary: 'Summary',
          ai_advice: 'Advice',
        },
        tokenUsage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 },
        rawResponse: '{}',
        estimatedCostUsd: 0,
        latencyMs: 1,
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({
        code: 'roadmap',
        version: 'v1',
        meta: { system: 'system' },
      }),
      render: jest.fn().mockReturnValue('prompt'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('ai-request-1'),
      saveAiResult: jest.fn().mockResolvedValue(undefined),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const courseMatcher = {
      matchCourses: jest.fn().mockReturnValue({
        per_skill: [
          {
            skill_canonical_name: 'react',
            required_level: 4,
            courses: Array.from({ length: 35 }, (_, index) => course(index + 1)),
          },
        ],
        uncovered_skills: [],
      }),
    };
    const service = new RoadmapService(
      llm as never,
      prompts as never,
      tracing as never,
      courseMatcher as never,
      undefined,
    );
    const input: RoadmapGenerateRequestDto = {
      target_role: 'Frontend Developer',
      hours_per_week: 8,
      prompt_template_code: 'roadmap',
      missing_skills: [
        {
          skill_canonical_name: 'react',
          display_name: 'React',
          required_level: 4,
          importance: 'REQUIRED',
        },
      ],
      partial_skills: [],
      language_pref: 'vi',
    };

    const out = await service.generate('user-1', input);

    expect(out.parsed_response.steps[0].recommended_courses).toHaveLength(30);
    expect(out.parsed_response.steps[0].recommended_courses.at(-1)?.id).toBe('react-30');
    expect(tracing.saveAiResult).toHaveBeenCalledWith(
      expect.objectContaining({
        parsedResponse: expect.objectContaining({
          steps: [
            expect.objectContaining({
              recommended_courses: expect.arrayContaining([
                expect.objectContaining({ id: 'react-30' }),
              ]),
            }),
          ],
        }),
      }),
    );
    const persisted =
      tracing.saveAiResult.mock.calls[0][0].parsedResponse.steps[0].recommended_courses;
    expect(persisted).toHaveLength(30);
  });
});
