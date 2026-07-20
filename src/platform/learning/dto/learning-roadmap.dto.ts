import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

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
  @MaxLength(160)
  id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  summary?: string;
}

export class TranslateDisplayRequestDto {
  @IsIn(['vi', 'en'])
  locale!: 'vi' | 'en';

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TranslateDisplayItemDto)
  items!: TranslateDisplayItemDto[];
}
