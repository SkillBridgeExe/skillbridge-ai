import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import {
  LearningSessionProgressResponseDto,
  UpdateLearningSessionProgressDto,
} from './dto/session-progress.dto';

@Injectable()
export class LearningSessionProgressService {
  constructor(
    @InjectRepository(LearningSessionProgressEntity)
    private readonly progress: Repository<LearningSessionProgressEntity>,
  ) {}

  async getProgress(userId: string, sessionId: string): Promise<LearningSessionProgressResponseDto> {
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

  private emptyResponse(sessionId: string): LearningSessionProgressResponseDto {
    return {
      session_id: sessionId,
      checked_checklist_items: {},
      exercise_proofs: {},
      updated_at: null,
    };
  }

  private toResponse(row: LearningSessionProgressEntity): LearningSessionProgressResponseDto {
    return {
      session_id: row.sessionId,
      checked_checklist_items: row.checkedChecklistItems ?? {},
      exercise_proofs: row.exerciseProofs ?? {},
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
