import { presentLearningResources } from '../../../src/platform/learning/learning-resource-policy';

const resource = (overrides: Record<string, unknown> = {}) => ({
  id: 'resource-1',
  source_type: 'video',
  title: 'English resource',
  provider: 'Trusted provider',
  language: 'en',
  duration_minutes: 90,
  validation_status: 'verified',
  match_score: 90,
  ...overrides,
});

describe('learning resource presentation policy', () => {
  it('keeps one short English primary resource and at most two supplementary resources', () => {
    const result = presentLearningResources(
      [
        resource(),
        resource({ id: 'resource-2', duration_minutes: 120 }),
        resource({ id: 'resource-3', duration_minutes: 150 }),
        resource({ id: 'resource-4', duration_minutes: 60 }),
      ],
      'FAST_TRACK',
    );

    expect(result.map((item) => item.resource_role)).toEqual([
      'PRIMARY',
      'SUPPLEMENTARY',
      'SUPPLEMENTARY',
    ]);
  });

  it('never presents non-English, pending or suspicious CJK metadata as verified English', () => {
    const result = presentLearningResources(
      [
        resource({ id: 'vi', language: 'vi' }),
        resource({ id: 'pending', validation_status: 'pending' }),
        resource({ id: 'cjk', title: '数据库教程' }),
        resource({ id: 'valid' }),
      ],
      'FAST_TRACK',
    );

    expect(result.map((item) => item.id)).toEqual(['valid']);
  });

  it('demotes a long unsegmented course but allows a chaptered resource as primary', () => {
    const result = presentLearningResources(
      [
        resource({ id: 'long', duration_minutes: 1610 }),
        resource({
          id: 'chaptered',
          duration_minutes: 480,
          video_chapters: [{ id: 'chapter-1', title: 'Core chapter', start_seconds: 120 }],
        }),
      ],
      'FAST_TRACK',
    );

    expect(result[0]).toEqual(
      expect.objectContaining({
        id: 'chaptered',
        resource_role: 'PRIMARY',
        duration_kind: 'EXACT',
        recommended_minutes: 60,
        recommended_segment: {
          label: 'Core chapter',
          chapter_ids: ['chapter-1'],
          start_seconds: 120,
        },
      }),
    );
    expect(result[1]).toEqual(
      expect.objectContaining({ id: 'long', resource_role: 'SUPPLEMENTARY' }),
    );
  });
});
