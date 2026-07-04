import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class UpdateLearningSessionProgressDto {
  @ApiPropertyOptional({
    description: 'Map of lesson section id to checked checklist item labels.',
    example: { star: ['Write one answer with Situation, Task, Action, and Result.'] },
  })
  @IsOptional()
  @IsObject()
  checked_checklist_items?: Record<string, string[]>;

  @ApiPropertyOptional({
    description: 'Map of exercise id to proof/note/link supplied by the learner.',
    example: { 'record-answer': 'Transcript saved in portfolio notes.' },
  })
  @IsOptional()
  @IsObject()
  exercise_proofs?: Record<string, string>;
}

export interface LearningSessionProgressResponseDto {
  session_id: string;
  checked_checklist_items: Record<string, string[]>;
  exercise_proofs: Record<string, string>;
  quiz_attempts: Record<string, unknown>;
  updated_at: string | null;
}

export class AnswerLearningQuizQuestionDto {
  @ApiPropertyOptional({
    description: 'Canonical skill for the lesson content that owns the question.',
    example: 'react',
  })
  @IsString()
  skill_canonical!: string;

  @ApiPropertyOptional({
    description: 'Stable question id from lesson_content.quiz.',
    example: 'state-purpose',
  })
  @IsString()
  question_id!: string;

  @ApiPropertyOptional({
    description: 'Zero-based selected option index. The server computes correctness.',
    example: 0,
  })
  @IsInt()
  @Min(0)
  selected_option_index!: number;
}

export class PatchLearningChecklistItemDto {
  @ApiPropertyOptional({
    description: 'Lesson section id that owns the checklist item.',
    example: 'state-events',
  })
  @IsString()
  section_id!: string;

  @ApiPropertyOptional({
    description: 'Whether the item should be checked after the patch.',
    example: true,
  })
  @IsBoolean()
  checked!: boolean;
}

export interface ObjectiveMasteryResponseDto {
  objective_id: string;
  correct: number;
  total_answered: number;
  accuracy: number;
  mastered: boolean;
}

export interface LearningQuizAnswerResponseDto {
  question_id: string;
  selected_option_index: number;
  is_correct: boolean;
  scored: boolean;
  attempt_count: number;
  correct_option_index: number;
  explanation: string;
  objective_mastery: ObjectiveMasteryResponseDto;
  lesson_status: 'not_started' | 'in_progress' | 'mastered';
  next_recommended_questions: Array<{
    id: string;
    question: string;
    options: string[];
    explanation: string;
    kind: 'concept' | 'scenario' | 'debug' | 'mini_case';
    objective_id: string;
    section_id: string;
  }>;
  remediation?: {
    section_id?: string;
    video_resource_id?: string;
    video_chapter_id?: string;
    start_seconds?: number;
  };
}

export interface LearningNextQuestionsResponseDto {
  weak_objectives: ObjectiveMasteryResponseDto[];
  next_recommended_questions: Array<{
    id: string;
    question: string;
    options: string[];
    explanation: string;
    kind: 'concept' | 'scenario' | 'debug' | 'mini_case';
    objective_id: string;
    section_id: string;
  }>;
}
