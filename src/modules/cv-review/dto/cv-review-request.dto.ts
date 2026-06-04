import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CvReviewRequestDto {
  @ApiProperty({
    description: 'CV identifier used for tracing and linking ai_results back to the CV.',
    example: '00000000-0000-0000-0000-000000000101',
    format: 'uuid',
  })
  @IsUUID()
  cv_id!: string;

  @ApiPropertyOptional({
    description: 'Optional document identifier when the CV text is tied to a document record.',
    example: '00000000-0000-0000-0000-000000000201',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  document_id?: string;

  @ApiProperty({
    description:
      'Extracted plain text from the CV. Do not send binary files to this internal endpoint.',
    example:
      'Nguyen Van A\nFrontend Developer\nSkills: React, TypeScript\nExperience:\n- Built a React dashboard used by 100 users',
  })
  @IsString()
  @IsNotEmpty()
  parsed_text!: string;

  @ApiProperty({
    description: 'Prompt template code for CV diagnosis.',
    example: 'cv_review_v1',
  })
  @IsString()
  @IsNotEmpty()
  prompt_template_code!: string;

  /**
   * Optional target role canonical name (e.g. "frontend_developer").
   * If provided, the LLM uses it to score `skills_relevance` dimension against
   * the implied requirements for that role. If omitted, scores against generic
   * tech industry expectations.
   */
  @ApiPropertyOptional({
    description: 'Canonical target role code used for role-specific scoring.',
    example: 'frontend_developer',
    maxLength: 120,
  })
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
  @ApiPropertyOptional({
    description: 'Original CV MIME type, used by deterministic ATS checks.',
    example: 'application/pdf',
  })
  @IsOptional()
  @IsString()
  mime_type?: string;

  /**
   * Optional flag: was the source file parsed via OCR (image-only PDF)?
   * If true, AtsRuleCheckerService heavily penalizes file_format_acceptable.
   */
  @ApiPropertyOptional({
    description: 'Whether the CV text came from OCR only.',
    example: false,
  })
  @IsOptional()
  is_ocr_only?: boolean;
}
