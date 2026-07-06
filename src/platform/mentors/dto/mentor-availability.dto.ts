import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMentorSlotDto {
  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;
}

export class ListMentorSlotsQueryDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}

export class MentorAvailabilityWindowDto {
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  endMinute!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SaveMentorAvailabilityTemplateDto {
  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsIn([0, 15, 30])
  bufferMinutes?: number;

  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => MentorAvailabilityWindowDto)
  windows!: MentorAvailabilityWindowDto[];
}

export interface MentorAvailabilityTemplateDto {
  timezone: string;
  bufferMinutes: number;
  windows: Array<{
    id: string;
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
    isActive: boolean;
  }>;
}

export interface MentorSlotDto {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  source: string;
  availabilityTemplateId?: string | null;
  holdExpiresAt?: string | null;
}
