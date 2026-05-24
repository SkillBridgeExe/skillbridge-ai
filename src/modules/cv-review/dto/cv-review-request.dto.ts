import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

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
}
