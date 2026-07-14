import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export class PatchRoadmapScheduleDto {
  @IsArray()
  schedule!: Array<{
    id: string;
    suggested_day_of_week: number;
    week_number: number;
    session_index: number;
  }>;
}

export class TranslateDisplayItemDto {
  @IsString()
  id!: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  summary?: string;
}

export class TranslateDisplayRequestDto {
  @IsIn(['vi', 'en'])
  locale!: 'vi' | 'en';

  @IsArray()
  items!: TranslateDisplayItemDto[];
}
