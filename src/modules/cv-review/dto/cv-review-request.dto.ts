import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CvReviewRequestDto {
  @IsUUID()
  cv_id!: string;

  @IsOptional()
  @IsUUID()
  document_id?: string;

  @IsString()
  @IsNotEmpty()
  parsed_text!: string;

  @IsString()
  @IsNotEmpty()
  prompt_template_code!: string;

  /**
   * Optional target role canonical name (e.g. "frontend_developer").
   * If provided, the LLM uses it to score `skills_relevance` dimension against
   * the implied requirements for that role. If omitted, scores against generic
   * tech industry expectations.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  // Anti-injection: this value is interpolated into the rubric SCORING INSTRUCTIONS, so
  // forbid newlines / braces that could break out of the data context.
  @Matches(/^[^\n\r{}]*$/, { message: 'target_role contains invalid characters' })
  target_role?: string;

  /**
   * Optional MIME type hint, used by AtsRuleCheckerService to verify file_format_acceptable.
   * Example: "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
   */
  @IsOptional()
  @IsString()
  mime_type?: string;

  /**
   * Optional flag: was the source file parsed via OCR (image-only PDF)?
   * If true, AtsRuleCheckerService heavily penalizes file_format_acceptable.
   */
  @IsOptional()
  is_ocr_only?: boolean;
}
