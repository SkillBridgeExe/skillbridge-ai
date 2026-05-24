import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export type InterviewType = 'HR' | 'TECHNICAL' | 'MIXED';
export type InterviewPhase =
  | 'INTRODUCTION'
  | 'TECHNICAL_DEEP_DIVE'
  | 'SCENARIO'
  | 'BEHAVIORAL'
  | 'WRAP_UP';

const INTERVIEW_TYPES: InterviewType[] = ['HR', 'TECHNICAL', 'MIXED'];

export class StartInterviewRequestDto {
  @IsUUID()
  session_id!: string;

  @IsIn(INTERVIEW_TYPES)
  interview_type!: InterviewType;

  @IsString()
  topic!: string;

  @IsString()
  language!: string;

  @IsOptional()
  @IsString()
  cv_context?: string;

  @IsString()
  prompt_template_code!: string;
}

export interface StartInterviewResponseDto {
  ai_request_id: string;
  first_message: string;
  first_question: string;
  phase: InterviewPhase;
  total_questions_planned: number;
  token_usage: number;
}
