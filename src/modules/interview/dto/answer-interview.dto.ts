import { IsArray, IsInt, IsNotEmpty, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { InterviewPhase } from './start-interview.dto';

export class QuestionHistoryItemDto {
  @IsInt()
  @Min(1)
  order!: number;

  @IsString()
  question!: string;

  @IsString()
  answer!: string;
}

export class AnswerInterviewRequestDto {
  @IsUUID()
  session_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionHistoryItemDto)
  question_history!: QuestionHistoryItemDto[];

  @IsString()
  @IsNotEmpty()
  current_user_answer!: string;

  @IsInt()
  @Min(1)
  current_question_order!: number;
}

export interface AnswerInterviewResponseDto {
  ai_request_id: string;
  ai_message: string;
  next_question: string | null;
  phase: InterviewPhase;
  finished: boolean;
  per_question_score: number;
  per_question_strengths: string[];
  per_question_improvements: string[];
}
