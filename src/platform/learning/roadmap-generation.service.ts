import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { LearningModuleEntity } from '../../database/entities/learning-module.entity';
import { LearningRoadmapEntity } from '../../database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../database/entities/learning-roadmap-version.entity';
import { LearningSessionEntity } from '../../database/entities/learning-session.entity';
import { LearningScheduleProfileEntity } from '../../database/entities/learning-schedule-profile.entity';
import { LearningAvailabilitySlotEntity } from '../../database/entities/learning-availability-slot.entity';
import type { ComposedRoadmap, ComposedRoadmapStep } from '../../modules/roadmap/roadmap-composer';
import type { SkillBridgeLessonContent } from '../../modules/roadmap/skillbridge-lesson-content';
import { RoadmapComposerService } from '../../modules/roadmap/roadmap-composer.service';
import { EntitlementsService } from '../billing/entitlements.service';
import {
  LearningRoadmapGenerateResponseDto,
  LearningRoadmapPreviewResponseDto,
} from './dto/roadmap.dto';
import { scheduleLearningModules } from './learning-scheduler';
import { buildStudyWeekdays, scheduleLearningCadence } from './learning-cadence';
import {
  buildLearningContentPlan,
  type LearningContentPlan,
  type LearningTrack,
  type PlannedLearningLesson,
} from './learning-content-planner';
import { DerivedLearningCandidates, LearningRoadmapDraftService } from './roadmap-draft.service';
import {
  applyResourceSelection,
  assertValidResourceSelection,
  composeLearningCandidates,
} from './learning-roadmap-resources';
import { LearningContentEnhancer } from './learning-content-enhancer';
import { presentLearningResources } from './learning-resource-policy';

const RESOURCE_CATALOG_VERSION = 'learning-resources-v1';
const CONTENT_VERSION = 'skillbridge-lessons-v1';

interface PreparedRoadmap {
  roadmap: LearningRoadmapEntity;
  derived: DerivedLearningCandidates;
  composed: ComposedRoadmap;
  contentPlan: LearningContentPlan;
  preview: LearningRoadmapPreviewResponseDto;
}

@Injectable()
export class LearningRoadmapGenerationService {
  constructor(
    @InjectRepository(LearningRoadmapEntity)
    private readonly roadmaps: Repository<LearningRoadmapEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly drafts: LearningRoadmapDraftService,
    private readonly composer: RoadmapComposerService,
    private readonly entitlements: EntitlementsService,
    private readonly contentEnhancer: LearningContentEnhancer,
  ) {}

  async preview(
    userId: string,
    roadmapId: string,
    expectedRevision: number,
  ): Promise<LearningRoadmapPreviewResponseDto> {
    return (await this.prepare(userId, roadmapId, expectedRevision)).preview;
  }

  async generate(
    userId: string,
    roadmapId: string,
    expectedRevision: number,
  ): Promise<LearningRoadmapGenerateResponseDto> {
    const prepared = await this.prepare(userId, roadmapId, expectedRevision);
    if (prepared.preview.modules.length === 0) {
      throw new BadRequestException('No current learning gaps are available to generate.');
    }

    const usage = await this.entitlements.reserveUsage(userId, BillingFeatureKey.ROADMAP_GENERATE, {
      sourceType: 'learning_roadmap_draft',
      sourceId: roadmapId,
    });
    try {
      const enhancedPreview = await this.contentEnhancer.enhance(prepared.preview);
      const finalPrepared: PreparedRoadmap = { ...prepared, preview: enhancedPreview };
      const versionId = await this.dataSource.transaction((manager) =>
        this.persistVersion(manager, userId, expectedRevision, finalPrepared),
      );
      await usage.confirm({ sourceType: 'learning_roadmap', sourceId: roadmapId });
      return {
        ...enhancedPreview,
        version_id: versionId,
        revision: expectedRevision + 1,
        status: 'ACTIVE',
      };
    } catch (error) {
      await usage.refund();
      throw error;
    }
  }

  private async prepare(
    userId: string,
    roadmapId: string,
    expectedRevision: number,
  ): Promise<PreparedRoadmap> {
    const roadmap = await this.roadmaps.findOne({ where: { id: roadmapId, userId } });
    if (!roadmap || roadmap.status !== 'DRAFT') {
      throw new NotFoundException(`Learning roadmap draft '${roadmapId}' was not found.`);
    }
    if (roadmap.revision !== expectedRevision) {
      throw new ConflictException('Learning roadmap draft has changed; reload before continuing.');
    }
    const schedule = roadmap.draftConfig.schedule;
    const cadence = roadmap.draftConfig.cadence;
    if (!cadence && (!schedule || schedule.slots.length === 0)) {
      throw new BadRequestException('Save a learning cadence before previewing.');
    }

    const timezone = cadence?.timezone ?? schedule!.timezone;
    const startDate = cadence?.start_date ?? todayInTimezone(timezone);
    const sessionMinutes = cadence?.session_minutes ?? schedule!.session_minutes;
    const legacyScheduleInput = schedule
      ? {
          timezone: schedule.timezone,
          startDate,
          deadline: schedule.deadline,
          sessionMinutes: schedule.session_minutes,
          slots: schedule.slots.map((slot) => ({
            isoWeekday: slot.iso_weekday,
            startTime: slot.start_time,
            durationMinutes: slot.duration_minutes,
          })),
        }
      : null;
    const capacitySchedule = legacyScheduleInput
      ? scheduleLearningModules({ ...legacyScheduleInput, modules: [] })
      : null;
    const derived = await this.drafts.rederiveCurrentCandidates(userId, roadmap);
    const selected = selectCurrentCandidates(roadmap, derived);
    const learningTrack: LearningTrack =
      roadmap.intent === 'JD_APPLICATION' ? 'FAST_TRACK' : 'FOUNDATION';
    const unfilteredComposed =
      selected.length === 0
        ? {
            budget_hours: 0,
            steps: [],
            not_feasible_items: [],
            ai_summary: 'No learning gaps remain.',
          }
        : composeLearningCandidates(
            this.composer,
            selected,
            roadmap.draftConfig.language_pref,
            cadence
              ? {
                  available_days: 7,
                  hours_per_week: (cadence.study_days_per_week * cadence.session_minutes) / 60,
                }
              : learningBudget(startDate, schedule!.deadline, capacitySchedule!.capacityMinutes),
          );
    const policyComposed: ComposedRoadmap = {
      ...unfilteredComposed,
      steps: unfilteredComposed.steps.map((step) => ({
        ...step,
        resources: presentLearningResources(step.resources, learningTrack),
      })),
    };
    const selectedResources = roadmap.draftConfig.selected_resources;
    if (selectedResources) {
      assertValidResourceSelection(selected, policyComposed, selectedResources);
    }
    const composed = applyResourceSelection(policyComposed, selectedResources);

    const stepBySkill = new Map(composed.steps.map((step) => [step.skill_canonical, step]));
    const contentPlan = buildLearningContentPlan({
      track: learningTrack,
      ...(capacitySchedule ? { capacityMinutes: capacitySchedule.capacityMinutes } : {}),
      candidates: selected.map((candidate) => ({
        skillCanonical: candidate.skill_canonical,
        displayName: candidate.display_name,
        systemPriority: candidate.system_priority,
        userRank: roadmap.draftConfig.selected_priorities?.find(
          (item) => item.skill_canonical === candidate.skill_canonical,
        )?.rank,
        prerequisites: candidate.prerequisites,
        lessonContent: stepBySkill.get(candidate.skill_canonical)?.lesson_content,
      })),
    });
    const schedulable = contentPlan.modules
      .filter((module) => module.scheduledMinutes > 0)
      .map((module) => ({
        skillCanonical: module.skillCanonical,
        displayName: module.displayName,
        estimatedMinutes: module.scheduledMinutes,
        systemPriority:
          learningTrack === 'FAST_TRACK'
            ? module.quickWinScore
            : selected.find((item) => item.skill_canonical === module.skillCanonical)!
                .system_priority,
        userRank: module.rank,
        prerequisites: module.prerequisites,
      }));

    let scheduled;
    try {
      scheduled = cadence
        ? scheduleLearningCadence({
            modules: schedulable,
            timezone: cadence.timezone,
            startDate: cadence.start_date,
            studyDaysPerWeek: cadence.study_days_per_week,
            sessionMinutes: cadence.session_minutes,
          })
        : scheduleLearningModules({
            ...legacyScheduleInput!,
            modules: schedulable,
          });
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    const sessionsWithLessons = attachLessonsToSessions(
      contentPlan,
      scheduled.sessions,
      sessionMinutes,
    );
    const candidateBySkill = new Map(
      selected.map((candidate) => [candidate.skill_canonical, candidate]),
    );
    const preview: LearningRoadmapPreviewResponseDto = {
      roadmap_id: roadmap.id,
      revision: roadmap.revision,
      target_role: derived.targetRole || null,
      summary: composed.ai_summary,
      learning_track: learningTrack,
      content_source: 'DETERMINISTIC',
      capacity_minutes: capacitySchedule?.capacityMinutes ?? scheduled.scheduledMinutes,
      scheduled_minutes: contentPlan.scheduledMinutes,
      coverage_percentage: contentPlan.coveragePercentage,
      cadence: cadence ?? {
        timezone,
        start_date: startDate,
        study_days_per_week: Math.min(
          7,
          Math.max(1, new Set(schedule!.slots.map((slot) => slot.iso_weekday)).size),
        ) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        session_minutes: sessionMinutes,
      },
      estimated_completion_date:
        'estimatedCompletionDate' in scheduled
          ? scheduled.estimatedCompletionDate
          : (scheduled.sessions.at(-1)?.scheduledStartAt.toISOString().slice(0, 10) ?? null),
      modules: contentPlan.modules.map((module) => {
        const candidate = candidateBySkill.get(module.skillCanonical)!;
        const step = stepBySkill.get(module.skillCanonical);
        return {
          skill_canonical: module.skillCanonical,
          display_name: candidate.display_name,
          rank: module.rank,
          estimated_minutes: module.scheduledMinutes,
          feasibility: module.scopeStatus === 'DEFERRED' ? 'DEFERRED' : 'FEASIBLE',
          resources: (step?.resources ?? []) as Array<Record<string, unknown>>,
          lesson_content: (step?.lesson_content as unknown as Record<string, unknown>) ?? null,
          quick_win_score: module.quickWinScore,
          scope_status: module.scopeStatus,
          prerequisite_warnings: module.prerequisites,
          lessons: module.lessons.map((lesson) => ({
            id: lesson.id,
            title: lesson.title,
            summary: lesson.summary,
            key_points: lesson.keyPoints,
            estimated_minutes: lesson.estimatedMinutes,
            importance: lesson.importance,
            kind: lesson.kind,
            scope_status: lesson.scopeStatus,
            ...(lesson.omissionReason ? { omission_reason: lesson.omissionReason } : {}),
            content_source: 'DETERMINISTIC',
          })),
        };
      }),
      sessions: sessionsWithLessons.map((session) => ({
        skill_canonical: session.skillCanonical,
        sequence: session.sequence,
        scheduled_start_at: session.scheduledStartAt.toISOString(),
        duration_minutes: session.durationMinutes,
        lesson_ids: session.lessonIds,
      })),
      deferred: contentPlan.modules
        .filter((module) => module.scopeStatus !== 'FULL')
        .map((module) => ({
          skill_canonical: module.skillCanonical,
          remaining_minutes: module.estimatedMinutes - module.scheduledMinutes,
        })),
    };
    return { roadmap, derived, composed, contentPlan, preview };
  }

  private async persistVersion(
    manager: EntityManager,
    userId: string,
    expectedRevision: number,
    prepared: PreparedRoadmap,
  ): Promise<string> {
    const locked = await manager.findOne(LearningRoadmapEntity, {
      where: { id: prepared.roadmap.id, userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!locked || locked.status !== 'DRAFT') {
      throw new NotFoundException(`Learning roadmap draft '${prepared.roadmap.id}' was not found.`);
    }
    if (locked.revision !== expectedRevision) {
      throw new ConflictException('Learning roadmap draft has changed; reload before generating.');
    }
    const latestVersion = await manager.findOne(LearningRoadmapVersionEntity, {
      where: { roadmapId: locked.id },
      order: { versionNo: 'DESC' },
    });
    const version = await manager.save(LearningRoadmapVersionEntity, {
      roadmapId: locked.id,
      versionNo: (latestVersion?.versionNo ?? 0) + 1,
      inputSnapshot: {
        ...(locked.draftConfig as unknown as Record<string, unknown>),
        generated_plan: {
          learning_track: prepared.preview.learning_track,
          coverage_percentage: prepared.preview.coverage_percentage,
          deferred: prepared.preview.deferred,
          content_source: prepared.preview.content_source,
          modules: prepared.preview.modules.map((module) => ({
            skill_canonical: module.skill_canonical,
            quick_win_score: module.quick_win_score,
            scope_status: module.scope_status,
            lessons: module.lessons,
          })),
        },
      },
      sourceGapSnapshot: prepared.derived.sourceGapSnapshot,
      resourceCatalogVersion: RESOURCE_CATALOG_VERSION,
      contentVersion: CONTENT_VERSION,
    });

    const schedule = locked.draftConfig.schedule;
    const cadence = locked.draftConfig.cadence;
    if (!cadence && !schedule) {
      throw new ConflictException('Learning cadence disappeared during generation.');
    }
    const existingProfile = await manager.findOne(LearningScheduleProfileEntity, {
      where: { userId, isDefault: true },
    });
    const profile = existingProfile
      ? await manager.save(LearningScheduleProfileEntity, {
          ...existingProfile,
          timezone: cadence?.timezone ?? schedule!.timezone,
          sessionMinutes: cadence?.session_minutes ?? schedule!.session_minutes,
        })
      : await manager.save(LearningScheduleProfileEntity, {
          userId,
          name: 'Default',
          timezone: cadence?.timezone ?? schedule!.timezone,
          sessionMinutes: cadence?.session_minutes ?? schedule!.session_minutes,
          isDefault: true,
        });
    await manager.delete(LearningAvailabilitySlotEntity, { profileId: profile.id });
    const availabilitySlots = cadence
      ? buildStudyWeekdays(cadence.start_date, cadence.study_days_per_week).map((isoWeekday) => ({
          iso_weekday: isoWeekday,
          start_time: '12:00',
          duration_minutes: cadence.session_minutes,
        }))
      : schedule!.slots;
    if (availabilitySlots.length > 0) {
      await manager.save(
        LearningAvailabilitySlotEntity,
        availabilitySlots.map((slot) => ({
          profileId: profile.id,
          isoWeekday: slot.iso_weekday,
          startTime: slot.start_time,
          durationMinutes: slot.duration_minutes,
        })),
      );
    }

    const candidateBySkill = new Map(
      prepared.derived.candidates.map((candidate) => [candidate.skill_canonical, candidate]),
    );
    const stepBySkill = new Map(
      prepared.composed.steps.map((step) => [step.skill_canonical, step]),
    );
    for (const modulePreview of [...prepared.preview.modules]
      .filter((module) => module.scope_status !== 'DEFERRED')
      .sort((a, b) => a.rank - b.rank)) {
      const candidate = candidateBySkill.get(modulePreview.skill_canonical);
      if (!candidate) throw new ConflictException('Roadmap candidates changed during generation.');
      const userPriority = locked.draftConfig.selected_priorities?.find(
        (item) => item.skill_canonical === modulePreview.skill_canonical,
      )?.rank;
      const module = await manager.save(LearningModuleEntity, {
        versionId: version.id,
        skillId: null,
        skillCanonical: modulePreview.skill_canonical,
        displayName: modulePreview.display_name,
        rank: modulePreview.rank,
        systemPriority: candidate.system_priority.toFixed(3),
        userPriority: userPriority ?? null,
        rationale: candidate.rationale,
        prerequisiteCanonicals: candidate.prerequisites,
        estimatedMinutes: modulePreview.estimated_minutes,
        feasibility: modulePreview.feasibility,
      });
      const moduleSessions = prepared.preview.sessions.filter(
        (session) => session.skill_canonical === modulePreview.skill_canonical,
      );
      const step = stepBySkill.get(modulePreview.skill_canonical);
      for (const session of moduleSessions) {
        const sessionLessons = modulePreview.lessons.filter((lesson) =>
          session.lesson_ids.includes(lesson.id),
        );
        await manager.save(LearningSessionEntity, {
          moduleId: module.id,
          sequence: session.sequence,
          title:
            sessionLessons[0]?.title ??
            `${modulePreview.display_name} · Session ${session.sequence}`,
          scheduledStartAt: new Date(session.scheduled_start_at),
          durationMinutes: session.duration_minutes,
          requiredTasks: requiredTasks(
            step,
            session.lesson_ids,
            session.sequence,
            moduleSessions.length,
          ),
        });
      }
    }

    await manager.update(
      LearningRoadmapEntity,
      { userId, status: 'ACTIVE' },
      { status: 'ARCHIVED' },
    );
    const activated = await manager.update(
      LearningRoadmapEntity,
      { id: locked.id, userId, status: 'DRAFT', revision: expectedRevision },
      { status: 'ACTIVE', activeVersionId: version.id, revision: expectedRevision + 1 },
    );
    if (activated.affected !== 1) {
      throw new ConflictException('Learning roadmap draft changed during generation.');
    }
    return version.id;
  }
}

function selectCurrentCandidates(
  roadmap: LearningRoadmapEntity,
  derived: DerivedLearningCandidates,
) {
  const priorities = roadmap.draftConfig.selected_priorities;
  if (!priorities?.length) return derived.candidates;
  const bySkill = new Map(
    derived.candidates.map((candidate) => [candidate.skill_canonical, candidate]),
  );
  return [...priorities]
    .sort((a, b) => a.rank - b.rank)
    .map((item) => bySkill.get(item.skill_canonical))
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
}

function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function learningBudget(
  startDate: string,
  deadline: string,
  capacityMinutes: number,
): { available_days: number; hours_per_week: number } {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${deadline}T00:00:00.000Z`);
  const availableDays = Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1);
  return {
    available_days: availableDays,
    hours_per_week: Number(((capacityMinutes / 60) * (7 / availableDays)).toFixed(2)),
  };
}

function attachLessonsToSessions(
  plan: LearningContentPlan,
  sessions: Array<{
    skillCanonical: string;
    sequence: number;
    scheduledStartAt: Date;
    durationMinutes: number;
  }>,
  sessionMinutes: number,
): Array<{
  skillCanonical: string;
  sequence: number;
  scheduledStartAt: Date;
  durationMinutes: number;
  lessonIds: string[];
}> {
  const groupsBySkill = new Map<string, PlannedLearningLesson[][]>();
  for (const module of plan.modules) {
    const included = module.lessons.filter((lesson) => lesson.scopeStatus === 'INCLUDED');
    const groups: PlannedLearningLesson[][] = [];
    for (const lesson of included) {
      const current = groups.at(-1);
      const currentMinutes = current?.reduce((sum, item) => sum + item.estimatedMinutes, 0) ?? 0;
      if (!current || currentMinutes + lesson.estimatedMinutes > sessionMinutes) {
        groups.push([lesson]);
      } else {
        current.push(lesson);
      }
    }
    groupsBySkill.set(module.skillCanonical, groups);
  }

  return sessions.map((session) => {
    const lessons = groupsBySkill.get(session.skillCanonical)?.[session.sequence - 1] ?? [];
    return {
      ...session,
      durationMinutes:
        lessons.reduce((sum, lesson) => sum + lesson.estimatedMinutes, 0) ||
        session.durationMinutes,
      lessonIds: lessons.map((lesson) => lesson.id),
    };
  });
}

function requiredTasks(
  step: ComposedRoadmapStep | undefined,
  lessonIds: string[],
  sequence: number,
  totalSessions: number,
): Array<Record<string, unknown>> {
  const tasks: Array<Record<string, unknown>> = [
    { type: 'study', sequence, total_sessions: totalSessions },
  ];
  if (step) {
    if (sequence === 1) tasks.push({ type: 'resources', items: step.resources });
    if (step.lesson_content) {
      const content = sliceLessonContent(step.lesson_content, lessonIds);
      if (content.sections.length > 0 || content.exercises.length > 0) {
        tasks.push({ type: 'lesson', content });
      }
    }
  }
  return tasks;
}

function sliceLessonContent(
  content: SkillBridgeLessonContent,
  lessonIds: string[],
): SkillBridgeLessonContent {
  const included = new Set(lessonIds);
  const sections = content.sections.filter((section) =>
    included.has(`${content.skill_canonical}:section:${section.id}`),
  );
  const exercises = content.exercises.filter((exercise) =>
    included.has(`${content.skill_canonical}:exercise:${exercise.id}`),
  );
  const sectionIds = new Set(sections.map((section) => section.id));
  const objectiveIds = new Set(sections.map((section) => section.objective_id));
  return {
    ...content,
    learning_objectives: content.learning_objectives.filter((objective) =>
      objectiveIds.has(objective.id),
    ),
    sections,
    quiz_bank: content.quiz_bank.filter((question) => sectionIds.has(question.section_id)),
    quiz: content.quiz.filter((question) => sectionIds.has(question.section_id)),
    exercises,
  };
}
