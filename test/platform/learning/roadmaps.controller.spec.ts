import { LearningRoadmapsController } from '../../../src/platform/learning/roadmaps.controller';
import { LearningDisplayController } from '../../../src/platform/learning/learning.controller';

describe('LearningRoadmapsController', () => {
  it('always scopes draft mutations and reads to the JWT user', async () => {
    const drafts = {
      createDraft: jest.fn().mockResolvedValue({ id: 'roadmap-1' }),
      updateDraft: jest.fn().mockResolvedValue({ id: 'roadmap-1', revision: 1 }),
      list: jest.fn().mockResolvedValue([]),
    };
    const generation = {
      preview: jest.fn().mockResolvedValue({ roadmap_id: 'roadmap-1' }),
      generate: jest.fn().mockResolvedValue({ roadmap_id: 'roadmap-1', version_id: 'version-1' }),
    };
    const queries = {
      getActive: jest.fn().mockResolvedValue({ id: 'roadmap-1' }),
      archiveActive: jest.fn().mockResolvedValue({ archived: 1 }),
    };
    const reschedule = {
      reschedule: jest.fn().mockResolvedValue({ id: 'roadmap-1', revision: 2 }),
    };
    const controller = new LearningRoadmapsController(
      drafts as never,
      generation as never,
      queries as never,
      reschedule as never,
    );
    const user = { userId: 'user-1' } as never;

    await controller.create(user, {
      intent: 'CAREER_ROLE',
      target_role: 'frontend_developer',
      target_level: 'fresher',
      cv_id: 'cv-1',
    });
    await controller.update(user, 'roadmap-1', {
      expected_revision: 0,
      language_pref: 'vi',
    });
    await controller.list(user);
    await controller.preview(user, 'roadmap-1', { expected_revision: 1 });
    await controller.generate(user, 'roadmap-1', { expected_revision: 1 });
    await controller.getActive(user, 'roadmap-1');
    await controller.archiveActive(user);
    await controller.reschedule(user, 'roadmap-1', {
      expected_revision: 1,
      start_date: '2026-08-03',
      study_days_per_week: 3,
    });

    expect(drafts.createDraft).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ intent: 'CAREER_ROLE' }),
    );
    expect(drafts.updateDraft).toHaveBeenCalledWith(
      'user-1',
      'roadmap-1',
      expect.objectContaining({ expected_revision: 0 }),
    );
    expect(drafts.list).toHaveBeenCalledWith('user-1');
    expect(generation.preview).toHaveBeenCalledWith('user-1', 'roadmap-1', 1);
    expect(generation.generate).toHaveBeenCalledWith('user-1', 'roadmap-1', 1);
    expect(queries.getActive).toHaveBeenCalledWith('user-1', 'roadmap-1');
    expect(queries.archiveActive).toHaveBeenCalledWith('user-1');
    expect(reschedule.reschedule).toHaveBeenCalledWith('user-1', 'roadmap-1', {
      expected_revision: 1,
      start_date: '2026-08-03',
      study_days_per_week: 3,
    });
  });
});

describe('LearningDisplayController', () => {
  it('passes a bounded batch to the transient translation service', async () => {
    const translation = {
      translateMany: jest.fn().mockResolvedValue([{ id: 'title', locale: 'vi', title: 'Tiêu đề' }]),
    };
    const controller = new LearningDisplayController(translation as never);

    await controller.translate({
      locale: 'vi',
      items: [{ id: 'title', title: 'Title' }],
    });

    expect(translation.translateMany).toHaveBeenCalledWith([
      { id: 'title', locale: 'vi', title: 'Title' },
    ]);
  });
});
