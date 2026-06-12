import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { RubricBand } from '../../../common/services/role-rubric.service';

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

  /**
   * Seniority yardstick for the RUBRIC path (spec 2026-06-11). Omitted ⇒ the service
   * defaults to 'fresher' (the product's audience). The JD path ignores it entirely —
   * the employer's bar is nobody's to lower.
   */
  @IsOptional()
  @IsIn(['intern', 'fresher', 'mid'])
  target_band?: RubricBand;
}
