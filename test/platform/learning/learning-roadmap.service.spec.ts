import { NotFoundException } from '@nestjs/common';
import { LearningRoadmapPlatformService } from '../../../src/platform/learning/learning-roadmap.service';
import { DisplayTranslationService } from '../../../src/modules/roadmap/display-translation.service';

describe('LearningRoadmapPlatformService', () => {
  const repo = () => ({
    findOne: jest.fn(),
    delete: jest.fn(),
    save: jest.fn(async (entity) => entity),
  });

  const serviceWith = (
    roadmaps = repo(),
    progress = repo(),
    displayTranslation?: { translateDisplay: jest.Mock },
  ) =>
    new LearningRoadmapPlatformService(
      roadmaps as never,
      progress as never,
      displayTranslation as never,
    );

  it('returns the active roadmap for a user', async () => {
    const roadmaps = repo();
    roadmaps.findOne.mockResolvedValueOnce({ id: 'roadmap-1', userId: 'user-1', active: true });
    const service = serviceWith(roadmaps);

    await expect(service.getActive('user-1')).resolves.toMatchObject({ id: 'roadmap-1' });
    expect(roadmaps.findOne).toHaveBeenCalledWith({
      where: { userId: 'user-1', active: true },
    });
  });

  it('patches schedule only for the active owned roadmap', async () => {
    const roadmaps = repo();
    roadmaps.findOne.mockResolvedValueOnce({
      id: 'roadmap-1',
      userId: 'user-1',
      active: true,
      schedule: [],
    });
    const service = serviceWith(roadmaps);
    const schedule = [{ id: 's1', week_number: 1, session_index: 1, suggested_day_of_week: 2 }];

    const result = await service.patchSchedule('user-1', 'roadmap-1', schedule);

    expect(result.schedule).toEqual(schedule);
    expect(roadmaps.findOne).toHaveBeenCalledWith({
      where: { id: 'roadmap-1', userId: 'user-1', active: true },
    });
    expect(roadmaps.save).toHaveBeenCalledWith(expect.objectContaining({ schedule }));
  });

  it('throws when patching a missing or inactive roadmap', async () => {
    const roadmaps = repo();
    roadmaps.findOne.mockResolvedValueOnce(null);
    const service = serviceWith(roadmaps);

    await expect(service.patchSchedule('user-1', 'roadmap-1', [])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('translates display items without changing caller ids', async () => {
    const roadmaps = repo();
    const displayTranslation = {
      translateDisplay: jest.fn(async (input) => ({
        ...input,
        title: `VI ${input.title}`,
      })),
    };
    const service = serviceWith(roadmaps, repo(), displayTranslation);

    const result = await service.translateDisplayItems({
      locale: 'vi',
      items: [{ id: 'session-1', title: 'React foundations' }],
    });

    expect(displayTranslation.translateDisplay).toHaveBeenCalledWith({
      locale: 'vi',
      title: 'React foundations',
      description: undefined,
      reason: undefined,
      summary: undefined,
    });
    expect(result).toEqual({
      items: [
        {
          id: 'session-1',
          translated_display: {
            locale: 'vi',
            title: 'VI React foundations',
            description: undefined,
            reason: undefined,
            summary: undefined,
          },
        },
      ],
    });
  });
});

describe('DisplayTranslationService local templates', () => {
  it('translates common learning titles while preserving technical terms', async () => {
    const service = new DisplayTranslationService();

    await expect(
      service.translateDisplay({
        locale: 'vi',
        title: 'React Tutorial for Beginners',
        description:
          'Curated React video with SkillBridge chapter markers for component, props, state, list, and effect remediation.',
      }),
    ).resolves.toMatchObject({
      title: 'Học React cơ bản cho người mới',
      description:
        'Video React được SkillBridge chọn lọc, có mốc chương cho component, props, state, list và effect.',
    });
  });

  it('handles quick-start and handbook titles without remote translation', async () => {
    const service = new DisplayTranslationService();

    await expect(
      service.translateDisplay({ locale: 'vi', title: 'Docker Get Started' }),
    ).resolves.toMatchObject({ title: 'Bắt đầu với Docker' });
    await expect(
      service.translateDisplay({ locale: 'vi', title: 'TypeScript Handbook' }),
    ).resolves.toMatchObject({ title: 'Sổ tay TypeScript' });
  });
});
