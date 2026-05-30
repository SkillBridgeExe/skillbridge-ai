import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CvJdMatchRequestDto {
  @IsUUID()
  cv_id!: string;

  @IsString()
  @IsNotEmpty()
  cv_text!: string;

  @IsOptional()
  @IsUUID()
  cv_document_id?: string;

  @IsOptional()
  @IsUUID()
  jd_id?: string;

  /**
   * Job Description text. Optional — if omitted, caller MUST provide `target_role`
   * so SkillDiffService can use the role rubric instead.
   */
  @IsOptional()
  @IsString()
  jd_text?: string;

  @IsOptional()
  @IsUUID()
  jd_document_id?: string;

  @IsString()
  @IsNotEmpty()
  scoring_template_code!: string;

  /**
   * Canonical role code (e.g. "frontend_developer"). If provided, SkillDiffService
   * uses the role rubric as the source of "required skills" (preferred — vetted by HR).
   * If omitted, falls back to LLM-extracted JD requirements.
   */
  @IsOptional()
  @IsString()
  target_role?: string;
}
