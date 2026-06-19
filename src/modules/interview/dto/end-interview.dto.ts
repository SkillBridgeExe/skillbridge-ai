import { IsArray, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionHistoryItemDto } from './answer-interview.dto';
import { InterviewGapItem } from '../interview-gap';

export class EndInterviewRequestDto {
  @IsUUID()
  session_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionHistoryItemDto)
  all_questions_answers!: QuestionHistoryItemDto[];

  @IsInt()
  @Min(0)
  duration_seconds!: number;

  @IsString()
  scoring_template_code!: string;

  @IsOptional()
  @IsString()
  probed_skills?: string;
}

export interface InterviewAiFeedback {
  summary: string;
  technical_delivery: {
    concept_accuracy: number;
    problem_solving: number;
    system_thinking: number;
    code_quality: number;
  };
  communication_flow: {
    articulation: number;
    listening_response: number;
    filler_words: number;
    structured_answers: number;
  };
  body_language: null | {
    eye_contact: number;
    posture: number;
    gestures: number;
    facial_expressions: number;
  };
  recommendations: string;
  suggested_modules: string[];
}

export interface PerQuestionScore {
  question_order: number;
  question: string;
  answer: string;
  ai_score: number;
  strengths: string[];
  improvements: string[];
  time_taken_seconds: number;
}

export interface EndInterviewParsedResponse {
  overall_score: number;
  semantic_score: number;
  llm_score: number;
  communication_score: number;
  ai_feedback: InterviewAiFeedback;
  per_question_scores: PerQuestionScore[];
  interview_gap_items: InterviewGapItem[];
}

export interface EndInterviewResponseDto {
  ai_request_id: string;
  parsed_response: EndInterviewParsedResponse;
  token_usage: number;
}
