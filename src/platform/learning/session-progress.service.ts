import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LearningModuleEntity } from '../../database/entities/learning-module.entity';
import { LearningRoadmapEntity } from '../../database/entities/learning-roadmap.entity';
import { LearningRoadmapVersionEntity } from '../../database/entities/learning-roadmap-version.entity';
import { LearningSessionEntity } from '../../database/entities/learning-session.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { getSkillBridgeLessonContent } from '../../modules/roadmap/skillbridge-lesson-content';
import type { SkillBridgeLessonContent } from '../../modules/roadmap/skillbridge-lesson-content';
import {
  answerQuizQuestion as scoreQuizQuestion,
  computeObjectiveMastery,
  QuizAttempt,
} from './quiz-mastery';
import {
  AnswerLearningQuizQuestionDto,
  LearningNextQuestionsResponseDto,
  LearningSessionProgressResponseDto,
  LearningQuizAnswerResponseDto,
  PatchLearningChecklistItemDto,
  UpdateLearningSessionProgressDto,
} from './dto/session-progress.dto';

@Injectable()
export class LearningSessionProgressService {
  constructor(
    @InjectRepository(LearningSessionProgressEntity)
    private readonly progress: Repository<LearningSessionProgressEntity>,
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
    @Optional()
    @InjectRepository(LearningSessionEntity)
    private readonly sessions?: Repository<LearningSessionEntity>,
  ) {}

  async getProgress(
    userId: string,
    sessionId: string,
  ): Promise<LearningSessionProgressResponseDto> {
    await this.assertOwnedV2Session(userId, sessionId);
    const row = await this.progress.findOne({ where: { userId, sessionId } });
    if (!row) return this.emptyResponse(sessionId);
    return this.toResponse(row);
  }

  async saveProgress(
    userId: string,
    sessionId: string,
    dto: UpdateLearningSessionProgressDto,
  ): Promise<LearningSessionProgressResponseDto> {
    if (Object.prototype.hasOwnProperty.call(dto.checked_checklist_items ?? {}, '__session')) {
      throw new BadRequestException(
        'Session completion must use the dedicated completion endpoint.',
      );
    }
    const isV2 = await this.assertOwnedV2Session(userId, sessionId);
    const existing = await this.progress.findOne({ where: { userId, sessionId } });
    const next =
      existing ??
      this.progress.create({
        userId,
        sessionId,
        ...(isV2 ? { learningSessionId: sessionId } : {}),
      });

    const checkedChecklistItems = normalizeChecklistItems(dto.checked_checklist_items);
    if (existing?.checkedChecklistItems?.__session?.includes('completed')) {
      checkedChecklistItems.__session = ['completed'];
    }
    next.checkedChecklistItems = checkedChecklistItems;
    next.exerciseProofs = normalizeExerciseProofs(dto.exercise_proofs);

    return this.toResponse(await this.progress.save(next));
  }

  async answerQuizQuestion(
    userId: string,
    sessionId: string,
    dto: AnswerLearningQuizQuestionDto,
  ): Promise<LearningQuizAnswerResponseDto> {
    const isV2 = await this.assertOwnedV2Session(userId, sessionId, dto.skill_canonical);
    const lesson = await this.resolveLesson(isV2, userId, sessionId, dto.skill_canonical);
    if (!lesson) {
      throw new NotFoundException(`Learning lesson '${dto.skill_canonical}' was not found.`);
    }
    if (
      sessionId.startsWith('roadmap-') &&
      sessionId !== legacyRoadmapSessionId(dto.skill_canonical)
    ) {
      throw new BadRequestException(
        `Session '${sessionId}' does not belong to lesson '${dto.skill_canonical}'.`,
      );
    }

    const question = lesson.quiz.find((item) => item.id === dto.question_id);
    if (!question) {
      throw new NotFoundException(`Quiz question '${dto.question_id}' was not found.`);
    }
    if (dto.selected_option_index >= question.options.length) {
      throw new BadRequestException('selected_option_index is outside the question options.');
    }

    const existing = await this.progress.findOne({ where: { userId, sessionId } });
    const existingAttempts = normalizeQuizAttempts(existing?.quizAttempts);
    const answeredAt = new Date().toISOString();
    const result = scoreQuizQuestion(
      existingAttempts[question.id],
      dto.selected_option_index,
      question.correct_option_index,
      answeredAt,
    );
    const quizAttempts = {
      ...existingAttempts,
      [question.id]: result.attempt,
    };

    const next =
      existing ??
      this.progress.create({
        userId,
        sessionId,
        ...(isV2 ? { learningSessionId: sessionId } : {}),
        checkedChecklistItems: {},
        exerciseProofs: {},
        quizAttempts,
      });
    next.quizAttempts = quizAttempts;

    const saved = await this.progress.save(next);
    const savedAttempts = normalizeQuizAttempts(saved.quizAttempts);
    const savedAttempt = savedAttempts[question.id] ?? result.attempt;
    const objectiveId = question.objective_id;
    const questionResults = lesson.quiz_bank
      .filter((item) => quizAttempts[item.id])
      .map((item) => ({
        questionId: item.id,
        objectiveId: item.objective_id,
        isCorrect: Boolean(quizAttempts[item.id].is_correct),
      }));
    const objectiveMastery = computeObjectiveMastery(objectiveId, questionResults);
    const lessonStatus = objectiveMastery.mastered ? 'mastered' : 'in_progress';
    const adaptive = buildAdaptiveNextQuestions(lesson.quiz_bank, quizAttempts, question.id);

    return {
      question_id: question.id,
      selected_option_index: savedAttempt.selected_option_index,
      is_correct: savedAttempt.is_correct,
      scored: result.scored,
      attempt_count: savedAttempt.attempts,
      correct_option_index: question.correct_option_index,
      explanation: question.explanation,
      objective_mastery: objectiveMastery,
      lesson_status: lessonStatus,
      next_recommended_questions: adaptive.next_recommended_questions,
      remediation: question.remediation ?? {
        section_id: question.section_id,
      },
    };
  }

  async getNextQuestions(
    userId: string,
    sessionId: string,
    skillCanonical: string,
  ): Promise<LearningNextQuestionsResponseDto> {
    const isV2 = await this.assertOwnedV2Session(userId, sessionId, skillCanonical);
    const lesson = await this.resolveLesson(isV2, userId, sessionId, skillCanonical);
    if (!lesson) {
      throw new NotFoundException(`Learning lesson '${skillCanonical}' was not found.`);
    }

    const existing = await this.progress.findOne({ where: { userId, sessionId } });
    return buildAdaptiveNextQuestions(
      lesson.quiz_bank,
      normalizeQuizAttempts(existing?.quizAttempts),
    );
  }

  async patchChecklistItem(
    userId: string,
    sessionId: string,
    itemId: string,
    dto: PatchLearningChecklistItemDto,
  ): Promise<LearningSessionProgressResponseDto> {
    if (dto.section_id === '__session') {
      throw new BadRequestException(
        'Session completion must use the dedicated completion endpoint.',
      );
    }
    const isV2 = await this.assertOwnedV2Session(userId, sessionId);
    const existing = await this.progress.findOne({ where: { userId, sessionId } });
    const next =
      existing ??
      this.progress.create({
        userId,
        sessionId,
        ...(isV2 ? { learningSessionId: sessionId } : {}),
        checkedChecklistItems: {},
        exerciseProofs: {},
        quizAttempts: {},
      });
    const checkedChecklistItems = normalizeChecklistItems(next.checkedChecklistItems);
    const current = new Set(checkedChecklistItems[dto.section_id] ?? []);
    if (dto.checked) {
      current.add(itemId);
    } else {
      current.delete(itemId);
    }
    checkedChecklistItems[dto.section_id] = [...current];
    next.checkedChecklistItems = checkedChecklistItems;

    return this.toResponse(await this.progress.save(next));
  }

  private async resolveLesson(
    isV2: boolean,
    _userId: string,
    sessionId: string,
    skillCanonical: string,
  ): Promise<SkillBridgeLessonContent | undefined> {
    if (!isV2) return getSkillBridgeLessonContent(skillCanonical);
    if (!this.sessions) {
      // Compatibility for isolated legacy tests; the application always injects this repository.
      return getSkillBridgeLessonContent(skillCanonical);
    }
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    const task = session?.requiredTasks?.find((item) => item.type === 'lesson');
    const content = task?.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new NotFoundException('Persisted lesson for session ' + sessionId + ' was not found.');
    }
    const lesson = content as unknown as SkillBridgeLessonContent;
    if (
      lesson.skill_canonical !== skillCanonical ||
      !Array.isArray(lesson.quiz) ||
      !Array.isArray(lesson.quiz_bank)
    ) {
      throw new BadRequestException(
        'Persisted lesson for session ' +
          sessionId +
          ' does not match skill ' +
          skillCanonical +
          '.',
      );
    }
    return lesson;
  }
  private async assertOwnedV2Session(
    userId: string,
    sessionId: string,
    skillCanonical?: string,
  ): Promise<boolean> {
    if (!UUID_PATTERN.test(sessionId)) return false;
    if (!this.dataSource) {
      throw new Error('Learning V2 session validation requires a DataSource.');
    }
    const query = this.dataSource
      .createQueryBuilder(LearningSessionEntity, 'session')
      .innerJoin(LearningModuleEntity, 'module', 'module.id = session.moduleId')
      .innerJoin(LearningRoadmapVersionEntity, 'version', 'version.id = module.versionId')
      .innerJoin(LearningRoadmapEntity, 'roadmap', 'roadmap.id = version.roadmapId')
      .select('module.skillCanonical', 'skill_canonical')
      .where('session.id = :sessionId', { sessionId })
      .andWhere('roadmap.userId = :userId', { userId });
    if (skillCanonical) {
      query.andWhere('module.skillCanonical = :skillCanonical', { skillCanonical });
    }
    const owned = await query.getRawOne<{ skill_canonical: string }>();
    if (!owned) throw new NotFoundException(`Learning session '${sessionId}' was not found.`);
    return true;
  }

  private emptyResponse(sessionId: string): LearningSessionProgressResponseDto {
    return {
      session_id: sessionId,
      checked_checklist_items: {},
      exercise_proofs: {},
      quiz_attempts: {},
      updated_at: null,
    };
  }

  private toResponse(row: LearningSessionProgressEntity): LearningSessionProgressResponseDto {
    return {
      session_id: row.sessionId,
      checked_checklist_items: row.checkedChecklistItems ?? {},
      exercise_proofs: row.exerciseProofs ?? {},
      quiz_attempts: row.quizAttempts ?? {},
      updated_at: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function legacyRoadmapSessionId(skillCanonical: string): string {
  const slug = skillCanonical
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `roadmap-${slug}`;
}

function normalizeChecklistItems(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, string[]> = {};
  for (const [sectionId, items] of Object.entries(value as Record<string, unknown>)) {
    if (!sectionId) continue;
    normalized[sectionId] = Array.isArray(items)
      ? Array.from(new Set(items.filter((item): item is string => typeof item === 'string')))
      : [];
  }
  return normalized;
}

function normalizeExerciseProofs(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, string> = {};
  for (const [exerciseId, proof] of Object.entries(value as Record<string, unknown>)) {
    if (exerciseId && typeof proof === 'string') normalized[exerciseId] = proof;
  }
  return normalized;
}

function normalizeQuizAttempts(value: unknown): Record<string, QuizAttempt> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, QuizAttempt> = {};
  for (const [questionId, attempt] of Object.entries(value as Record<string, unknown>)) {
    if (!questionId || !attempt || typeof attempt !== 'object' || Array.isArray(attempt)) continue;
    const raw = attempt as Record<string, unknown>;
    if (
      typeof raw.selected_option_index !== 'number' ||
      typeof raw.is_correct !== 'boolean' ||
      typeof raw.attempts !== 'number' ||
      typeof raw.answered_at !== 'string'
    ) {
      continue;
    }
    normalized[questionId] = {
      selected_option_index: raw.selected_option_index,
      is_correct: raw.is_correct,
      attempts: raw.attempts,
      answered_at: raw.answered_at,
      last_answered_at:
        typeof raw.last_answered_at === 'string' ? raw.last_answered_at : raw.answered_at,
    };
  }
  return normalized;
}

function buildAdaptiveNextQuestions(
  quizBank: Array<{
    id: string;
    question: string;
    options: string[];
    explanation: string;
    kind: 'concept' | 'scenario' | 'debug' | 'mini_case';
    objective_id: string;
    section_id: string;
  }>,
  quizAttempts: Record<string, QuizAttempt>,
  excludeQuestionId?: string,
): LearningNextQuestionsResponseDto {
  const answered = quizBank
    .filter((item) => quizAttempts[item.id])
    .map((item) => ({
      questionId: item.id,
      objectiveId: item.objective_id,
      isCorrect: Boolean(quizAttempts[item.id].is_correct),
    }));
  const weakObjectives =
    answered.length > 0
      ? Array.from(new Set(answered.map((item) => item.objectiveId)))
          .map((objectiveId) => computeObjectiveMastery(objectiveId, answered))
          .filter((mastery) => !mastery.mastered)
      : [];
  const weakObjectiveIds = new Set(weakObjectives.map((item) => item.objective_id));
  const candidates =
    weakObjectiveIds.size > 0
      ? quizBank.filter((item) => weakObjectiveIds.has(item.objective_id))
      : quizBank;

  return {
    weak_objectives: weakObjectives,
    next_recommended_questions: candidates
      .filter((item) => item.id !== excludeQuestionId)
      .filter((item) => !quizAttempts[item.id])
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        question: item.question,
        options: item.options,
        explanation: item.explanation,
        kind: item.kind,
        objective_id: item.objective_id,
        section_id: item.section_id,
      })),
  };
}
