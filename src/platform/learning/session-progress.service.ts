import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import { getSkillBridgeLessonContent } from '../../modules/roadmap/skillbridge-lesson-content';
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
  ) {}

  async getProgress(
    userId: string,
    sessionId: string,
  ): Promise<LearningSessionProgressResponseDto> {
    const row = await this.progress.findOne({ where: { userId, sessionId } });
    if (!row) return this.emptyResponse(sessionId);
    return this.toResponse(row);
  }

  async saveProgress(
    userId: string,
    sessionId: string,
    dto: UpdateLearningSessionProgressDto,
  ): Promise<LearningSessionProgressResponseDto> {
    const existing = await this.progress.findOne({ where: { userId, sessionId } });
    const next = existing ?? this.progress.create({ userId, sessionId });

    next.checkedChecklistItems = normalizeChecklistItems(dto.checked_checklist_items);
    next.exerciseProofs = normalizeExerciseProofs(dto.exercise_proofs);

    return this.toResponse(await this.progress.save(next));
  }

  async answerQuizQuestion(
    userId: string,
    sessionId: string,
    dto: AnswerLearningQuizQuestionDto,
  ): Promise<LearningQuizAnswerResponseDto> {
    const lesson = getSkillBridgeLessonContent(dto.skill_canonical);
    if (!lesson) {
      throw new NotFoundException(`Learning lesson '${dto.skill_canonical}' was not found.`);
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
    const lesson = getSkillBridgeLessonContent(skillCanonical);
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
    const existing = await this.progress.findOne({ where: { userId, sessionId } });
    const next =
      existing ??
      this.progress.create({
        userId,
        sessionId,
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
