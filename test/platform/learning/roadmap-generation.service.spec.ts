import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { LearningRoadmapEntity } from '../../../src/database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../../src/database/entities/learning-roadmap-version.entity';
import { LearningModuleEntity } from '../../../src/database/entities/learning-module.entity';
import { LearningSessionEntity } from '../../../src/database/entities/learning-session.entity';
import { LearningRoadmapGenerationService } from '../../../src/platform/learning/roadmap-generation.service';

const lessonContent = {
  skill_canonical: 'typescript',
  title: 'TypeScript foundations',
  summary: 'Learn TypeScript.',
  license_type: 'skillbridge_original',
  reuse_policy: 'full_reuse_allowed',
  source_resource_ids: ['resource-1'],
  learning_objectives: [
    { id: 'types', title: 'Types', description: 'Use basic types.' },
    { id: 'narrowing', title: 'Narrowing', description: 'Narrow unions.' },
  ],
  sections: [
    {
      id: 'types',
      title: 'Basic types',
      body: 'Use explicit types at system boundaries.',
      objective_id: 'types',
      checklist: [{ id: 'types-check', label: 'Type one function' }],
    },
    {
      id: 'narrowing',
      title: 'Union narrowing',
      body: 'Narrow union values before using them.',
      objective_id: 'narrowing',
      checklist: [{ id: 'narrowing-check', label: 'Narrow one union' }],
    },
  ],
  quiz_bank: [],
  quiz: [],
  pass_policy: { min_correct_per_objective: 1, min_accuracy: 0.7 },
  exercises: [
    {
      id: 'typed-card',
      title: 'Build a typed card',
      prompt: 'Type a card model.',
      acceptance_criteria: ['No any', 'Save proof'],
      proof_of_completion: 'Save the code.',
    },
  ],
};

const draft = (): LearningRoadmapEntity =>
  ({
    id: 'roadmap-1',
    userId: 'user-1',
    intent: 'CAREER_ROLE',
    status: 'DRAFT',
    revision: 2,
    cvMatchId: null,
    targetRole: 'frontend_developer',
    targetLevel: 'fresher',
    activeVersionId: null,
    draftConfig: {
      language_pref: 'both',
      source_cv_id: 'cv-1',
      candidate_skills: [
        {
          skill_canonical: 'typescript',
          display_name: 'TypeScript',
          system_priority: 0.8,
          rationale: 'Required for the role.',
          prerequisites: [],
        },
      ],
      selected_priorities: [{ skill_canonical: 'typescript', rank: 1 }],
      schedule: {
        timezone: 'Asia/Ho_Chi_Minh',
        deadline: '2026-08-31',
        session_minutes: 60,
        slots: [{ iso_weekday: 1, start_time: '19:00', duration_minutes: 60 }],
      },
    },
  }) as unknown as LearningRoadmapEntity;

function setup() {
  const roadmaps = { findOne: jest.fn().mockResolvedValue(draft()) };
  const drafts = {
    rederiveCurrentCandidates: jest.fn().mockResolvedValue({
      targetRole: 'frontend_developer',
      candidates: draft().draftConfig.candidate_skills,
      sourceGapSnapshot: { source: 'career_role', skills: ['typescript'] },
    }),
  };
  const composer = {
    compose: jest.fn().mockReturnValue({
      budget_hours: 100,
      ai_summary: 'Focus on TypeScript.',
      not_feasible_items: [],
      steps: [
        {
          skill_canonical: 'typescript',
          display_name: 'TypeScript',
          estimated_hours: 2,
          priority: 0.8,
          resources: [
            {
              id: 'resource-1',
              source_type: 'official_doc',
              title: 'TypeScript handbook',
              provider: 'TypeScript',
              language: 'en',
              duration_minutes: 120,
              validation_status: 'verified',
            },
          ],
          lesson_content: lessonContent,
        },
      ],
    }),
  };
  const reservation = {
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const entitlements = {
    reserveUsage: jest.fn().mockResolvedValue(reservation),
  };
  const enhancer = {
    enhance: jest.fn(async (value) => ({ ...value, content_source: 'AI_ENHANCED' })),
  };
  let nextId = 0;
  const manager = {
    findOne: jest.fn().mockResolvedValue(draft()),
    create: jest.fn((_entity, value) => value),
    save: jest.fn(async (entity, value) => ({
      ...value,
      id:
        entity === LearningRoadmapVersionEntity
          ? 'version-1'
          : entity === LearningModuleEntity
            ? 'module-1'
            : entity === LearningSessionEntity
              ? `session-${++nextId}`
              : `saved-${++nextId}`,
    })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = {
    transaction: jest.fn(async (callback) => callback(manager)),
  };
  const service = new LearningRoadmapGenerationService(
    roadmaps as unknown as Repository<LearningRoadmapEntity>,
    dataSource as unknown as DataSource,
    drafts as never,
    composer as never,
    entitlements as never,
    enhancer as never,
  );
  return {
    service,
    roadmaps,
    drafts,
    composer,
    entitlements,
    enhancer,
    reservation,
    dataSource,
    manager,
  };
}

describe('LearningRoadmapGenerationService', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-07-21T00:00:00.000Z')));
  afterEach(() => jest.useRealTimers());

  it('previews a real dated schedule without charging quota or writing data', async () => {
    const { service, entitlements, enhancer, dataSource } = setup();

    const result = await service.preview('user-1', 'roadmap-1', 2);

    expect(result.modules).toEqual([
      expect.objectContaining({ skill_canonical: 'typescript', feasibility: 'FEASIBLE' }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        learning_track: 'FOUNDATION',
        content_source: 'DETERMINISTIC',
        coverage_percentage: 100,
      }),
    );
    expect(result.modules[0].lessons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Basic types',
          estimated_minutes: expect.any(Number),
          scope_status: 'INCLUDED',
        }),
      ]),
    );
    expect(result.sessions[0]).toEqual(
      expect.objectContaining({
        skill_canonical: 'typescript',
        scheduled_start_at: '2026-07-27T12:00:00.000Z',
      }),
    );
    expect(entitlements.reserveUsage).not.toHaveBeenCalled();
    expect(enhancer.enhance).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('projects a deadline-free cadence from the learner start date', async () => {
    const cadenceDraft = draft();
    cadenceDraft.draftConfig.cadence = {
      timezone: 'Asia/Ho_Chi_Minh',
      start_date: '2026-08-03',
      study_days_per_week: 3,
      session_minutes: 60,
    };
    delete cadenceDraft.draftConfig.schedule;
    const { service, roadmaps } = setup();
    roadmaps.findOne.mockResolvedValue(cadenceDraft);

    const result = await service.preview('user-1', 'roadmap-1', 2);

    expect(result.cadence).toEqual(cadenceDraft.draftConfig.cadence);
    expect(result.estimated_completion_date).toMatch(/^2026-08-/);
    expect(result.sessions[0].scheduled_start_at).toBe('2026-08-03T05:00:00.000Z');
    expect(result.sessions.every((session) => session.scheduled_start_at <= '2026-09-01')).toBe(
      true,
    );
  });

  it('reports only scheduled core minutes for a fast-track module', async () => {
    const fastTrackDraft = draft();
    fastTrackDraft.intent = 'JD_APPLICATION';
    fastTrackDraft.cvMatchId = 'match-1';
    fastTrackDraft.draftConfig.cadence = {
      timezone: 'Asia/Ho_Chi_Minh',
      start_date: '2026-08-03',
      study_days_per_week: 3,
      session_minutes: 60,
    };
    delete fastTrackDraft.draftConfig.schedule;
    const { service, roadmaps } = setup();
    roadmaps.findOne.mockResolvedValue(fastTrackDraft);

    const result = await service.preview('user-1', 'roadmap-1', 2);
    const scheduledMinutes = result.sessions
      .filter((session) => session.skill_canonical === 'typescript')
      .reduce((sum, session) => sum + session.duration_minutes, 0);
    const fullContentMinutes = result.modules[0].lessons.reduce(
      (sum, lesson) => sum + lesson.estimated_minutes,
      0,
    );

    expect(result.learning_track).toBe('FAST_TRACK');
    expect(result.modules[0].estimated_minutes).toBe(scheduledMinutes);
    expect(result.modules[0].estimated_minutes).toBeLessThan(fullContentMinutes);
  });

  it('enhances once during generate but never during preview', async () => {
    const { service, enhancer } = setup();

    await service.preview('user-1', 'roadmap-1', 2);
    expect(enhancer.enhance).not.toHaveBeenCalled();

    const result = await service.generate('user-1', 'roadmap-1', 2);
    expect(enhancer.enhance).toHaveBeenCalledTimes(1);
    expect(result.content_source).toBe('AI_ENHANCED');
  });

  it('uses only the server-validated resource selection in preview and persisted tasks', async () => {
    const selectedDraft = draft();
    (
      selectedDraft.draftConfig as unknown as { selected_resources: Record<string, string[]> }
    ).selected_resources = {
      typescript: ['resource-2'],
    };
    const { service, roadmaps, composer, manager } = setup();
    roadmaps.findOne.mockResolvedValue(selectedDraft);
    manager.findOne.mockImplementation((entity) =>
      Promise.resolve(entity === LearningRoadmapEntity ? selectedDraft : null),
    );
    composer.compose.mockReturnValue({
      budget_hours: 100,
      ai_summary: 'Focus on TypeScript.',
      not_feasible_items: [],
      steps: [
        {
          skill_canonical: 'typescript',
          display_name: 'TypeScript',
          estimated_hours: 2,
          priority: 0.8,
          resources: [
            {
              id: 'resource-1',
              source_type: 'official_doc',
              title: 'TypeScript handbook',
              provider: 'TypeScript',
              language: 'en',
              duration_minutes: 120,
              validation_status: 'verified',
            },
            {
              id: 'resource-2',
              source_type: 'exercise',
              title: 'TypeScript practice',
              provider: 'SkillBridge',
              language: 'en',
              duration_minutes: 60,
              validation_status: 'verified',
            },
          ],
          lesson_content: lessonContent,
        },
      ],
    });

    const preview = await service.preview('user-1', 'roadmap-1', 2);
    expect(preview.modules[0].resources).toEqual([expect.objectContaining({ id: 'resource-2' })]);

    await service.generate('user-1', 'roadmap-1', 2);
    expect(manager.save).toHaveBeenCalledWith(
      LearningSessionEntity,
      expect.objectContaining({
        requiredTasks: expect.arrayContaining([
          expect.objectContaining({
            type: 'resources',
            items: [expect.objectContaining({ id: 'resource-2' })],
          }),
        ]),
      }),
    );
  });

  it('presents one curated primary resource and excludes unverified language metadata', async () => {
    const { service, composer } = setup();
    composer.compose.mockReturnValue({
      budget_hours: 7,
      ai_summary: 'Focus on TypeScript.',
      not_feasible_items: [],
      steps: [
        {
          skill_canonical: 'typescript',
          display_name: 'TypeScript',
          estimated_hours: 2,
          priority: 0.8,
          resources: [
            {
              id: 'long',
              source_type: 'video',
              title: 'Long course',
              provider: 'Provider',
              language: 'en',
              duration_minutes: 900,
              validation_status: 'verified',
            },
            {
              id: 'primary',
              source_type: 'video',
              title: 'Focused lesson',
              provider: 'Provider',
              language: 'en',
              duration_minutes: 90,
              validation_status: 'verified',
            },
            {
              id: 'wrong-language',
              source_type: 'video',
              title: 'Khóa học',
              provider: 'Provider',
              language: 'vi',
              duration_minutes: 60,
              validation_status: 'verified',
            },
          ],
          lesson_content: lessonContent,
        },
      ],
    });

    const preview = await service.preview('user-1', 'roadmap-1', 2);

    expect(preview.modules[0].resources).toEqual([
      expect.objectContaining({ id: 'primary', resource_role: 'PRIMARY' }),
      expect.objectContaining({ id: 'long', resource_role: 'SUPPLEMENTARY' }),
    ]);
  });

  it('refuses preview when the draft revision is stale or no schedule was saved', async () => {
    const { service, roadmaps } = setup();
    await expect(service.preview('user-1', 'roadmap-1', 1)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const withoutSchedule = draft();
    delete withoutSchedule.draftConfig.schedule;
    roadmaps.findOne.mockResolvedValue(withoutSchedule);
    await expect(service.preview('user-1', 'roadmap-1', 2)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('persists an immutable version, modules and sessions in one transaction then charges once', async () => {
    const { service, entitlements, reservation, manager } = setup();

    const result = await service.generate('user-1', 'roadmap-1', 2);

    expect(entitlements.reserveUsage).toHaveBeenCalledTimes(1);
    expect(manager.findOne).toHaveBeenCalledWith(
      LearningRoadmapEntity,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      LearningRoadmapVersionEntity,
      expect.objectContaining({ roadmapId: 'roadmap-1', versionNo: 1 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      LearningModuleEntity,
      expect.objectContaining({ versionId: 'version-1', skillCanonical: 'typescript' }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      LearningSessionEntity,
      expect.objectContaining({
        moduleId: 'module-1',
        requiredTasks: expect.arrayContaining([expect.objectContaining({ type: 'resources' })]),
      }),
    );
    const persistedSessions = manager.save.mock.calls
      .filter(([entity]) => entity === LearningSessionEntity)
      .map(([, value]) => value);
    expect(persistedSessions.flatMap((item) => item.requiredTasks)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'evidence' })]),
    );
    expect(manager.update).toHaveBeenCalledWith(
      LearningRoadmapEntity,
      { userId: 'user-1', status: 'ACTIVE' },
      { status: 'ARCHIVED' },
    );
    expect(manager.update).toHaveBeenCalledWith(
      LearningRoadmapEntity,
      { id: 'roadmap-1', userId: 'user-1', status: 'DRAFT', revision: 2 },
      { status: 'ACTIVE', activeVersionId: 'version-1', revision: 3 },
    );
    expect(reservation.confirm).toHaveBeenCalledWith({
      sourceType: 'learning_roadmap',
      sourceId: 'roadmap-1',
    });
    expect(result.version_id).toBe('version-1');
  });

  it('refunds quota when transactional persistence fails', async () => {
    const { service, dataSource, reservation } = setup();
    dataSource.transaction.mockRejectedValue(new Error('database unavailable'));

    await expect(service.generate('user-1', 'roadmap-1', 2)).rejects.toThrow(
      'database unavailable',
    );
    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });
});
