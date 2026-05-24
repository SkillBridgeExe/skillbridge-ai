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

  @IsUUID()
  jd_id!: string;

  @IsString()
  @IsNotEmpty()
  jd_text!: string;

  @IsOptional()
  @IsUUID()
  jd_document_id?: string;

  @IsString()
  @IsNotEmpty()
  scoring_template_code!: string;
}
