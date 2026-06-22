import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateLearningPreferencesDto {
  @IsOptional()
  @IsIn(['vi', 'en', 'both'])
  language_pref?: 'vi' | 'en' | 'both';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  available_days?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(80)
  hours_per_week?: number;
}
