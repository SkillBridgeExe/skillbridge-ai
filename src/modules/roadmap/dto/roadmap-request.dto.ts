import { IsInt, IsObject, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class RoadmapGenerateRequestDto {
  @IsString()
  cv_text!: string;

  @IsOptional()
  @IsUUID()
  cv_document_id?: string;

  @IsOptional()
  @IsString()
  jd_text?: string;

  @IsOptional()
  @IsUUID()
  jd_document_id?: string;

  @IsString()
  target_role!: string;

  @IsInt()
  @Min(1)
  @Max(80)
  hours_per_week!: number;

  @IsOptional()
  @IsObject()
  user_profile?: Record<string, unknown>;

  @IsString()
  prompt_template_code!: string;
}
