import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

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
  updated_at: string | null;
}
