import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsObject,
  IsString,
  IsTimeZone,
  IsUUID,
  MaxLength,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  LearningCandidateSkill,
  LearningRoadmapCadenceDraft,
  LearningRoadmapIntent,
  LearningRoadmapScheduleDraft,
} from '../../../database/entities/learning-roadmap.entity';

export class CreateLearningRoadmapDraftDto {
  @IsIn(['JD_APPLICATION', 'CAREER_ROLE'])
  intent!: LearningRoadmapIntent;

  @IsOptional()
  @IsUUID()
  cv_match_id?: string;

  @IsOptional()
  @IsUUID()
  cv_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_]{2,100}$/)
  target_role?: string;

  @IsOptional()
  @IsIn(['intern', 'fresher', 'mid'])
  target_level?: 'intern' | 'fresher' | 'mid';

  @IsOptional()
  @IsIn(['vi', 'en', 'both'])
  language_pref?: 'vi' | 'en' | 'both';
}

export class LearningPriorityDto {
  @IsString()
  skill_canonical!: string;

  @IsInt()
  @Min(1)
  rank!: number;
}

export class LearningAvailabilitySlotDto {
  @IsInt()
  @Min(1)
  @Max(7)
  iso_weekday!: number;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  start_time!: string;

  @IsInt()
  @Min(30)
  @Max(720)
  duration_minutes!: number;
}

export class LearningScheduleDraftDto {
  @IsString()
  timezone!: string;

  @IsDateString({ strict: true })
  deadline!: string;

  @IsIn([30, 45, 60, 90])
  session_minutes!: 30 | 45 | 60 | 90;

  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => LearningAvailabilitySlotDto)
  slots!: LearningAvailabilitySlotDto[];
}

export class LearningCadenceDraftDto {
  @IsString()
  @IsTimeZone()
  timezone!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  start_date!: string;

  @IsInt()
  @Min(1)
  @Max(7)
  study_days_per_week!: 1 | 2 | 3 | 4 | 5 | 6 | 7;

  @IsIn([30, 45, 60, 90])
  session_minutes!: 30 | 45 | 60 | 90;
}

export class UpdateLearningRoadmapDraftDto {
  @IsInt()
  @Min(0)
  expected_revision!: number;

  @IsOptional()
  @IsIn(['vi', 'en', 'both'])
  language_pref?: 'vi' | 'en' | 'both';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LearningPriorityDto)
  selected_priorities?: LearningPriorityDto[];

  @IsOptional()
  @IsObject()
  selected_resources?: Record<string, string[]>;

  @IsOptional()
  @ValidateNested()
  @Type(() => LearningScheduleDraftDto)
  schedule?: LearningScheduleDraftDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LearningCadenceDraftDto)
  cadence?: LearningCadenceDraftDto;

  // Compatibility convenience for the first API iteration. The service folds it into schedule.
  @IsOptional()
  @IsDateString({ strict: true })
  deadline?: string;
}

export class LearningRoadmapGenerateDto {
  @IsInt()
  @Min(0)
  expected_revision!: number;
}

export class RescheduleLearningRoadmapDto {
  @IsInt()
  @Min(0)
  expected_revision!: number;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  start_date!: string;

  @IsInt()
  @Min(1)
  @Max(7)
  study_days_per_week!: 1 | 2 | 3 | 4 | 5 | 6 | 7;

  @IsOptional()
  @IsIn([30, 45, 60, 90])
  session_minutes?: 30 | 45 | 60 | 90;
}

export class TranslateLearningDisplayItemDto {
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

export class TranslateLearningDisplayDto {
  @IsIn(['vi', 'en'])
  locale!: 'vi' | 'en';

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TranslateLearningDisplayItemDto)
  items!: TranslateLearningDisplayItemDto[];
}

export interface LearningRoadmapPreviewResponseDto {
  roadmap_id: string;
  revision: number;
  target_role: string | null;
  summary: string;
  learning_track: 'FAST_TRACK' | 'FOUNDATION';
  content_source: 'DETERMINISTIC' | 'AI_ENHANCED' | 'DETERMINISTIC_FALLBACK';
  capacity_minutes: number;
  scheduled_minutes: number;
  coverage_percentage: number;
  cadence: LearningRoadmapCadenceDraft;
  estimated_completion_date: string | null;
  modules: Array<{
    skill_canonical: string;
    display_name: string;
    rank: number;
    estimated_minutes: number;
    feasibility: 'FEASIBLE' | 'DEFERRED';
    resources: Array<Record<string, unknown>>;
    lesson_content: Record<string, unknown> | null;
    quick_win_score: number;
    scope_status: 'FULL' | 'CORE_ONLY' | 'INTRO_ONLY' | 'DEFERRED';
    prerequisite_warnings: string[];
    lessons: Array<{
      id: string;
      title: string;
      summary: string;
      key_points: string[];
      estimated_minutes: number;
      importance: 'CORE' | 'EXTENSION';
      kind: 'LEARN' | 'PRACTICE';
      scope_status: 'INCLUDED' | 'OMITTED';
      omission_reason?: 'TIME_LIMIT' | 'PREREQUISITE' | 'LOWER_PRIORITY';
      content_source: 'DETERMINISTIC' | 'AI_ENHANCED' | 'DETERMINISTIC_FALLBACK';
    }>;
  }>;
  sessions: Array<{
    skill_canonical: string;
    sequence: number;
    scheduled_start_at: string;
    duration_minutes: number;
    lesson_ids: string[];
  }>;
  deferred: Array<{ skill_canonical: string; remaining_minutes: number }>;
}

export interface LearningRoadmapGenerateResponseDto extends LearningRoadmapPreviewResponseDto {
  version_id: string;
  revision: number;
  status: 'ACTIVE';
}

export interface LearningRoadmapDraftResponseDto {
  id: string;
  intent: LearningRoadmapIntent;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  revision: number;
  cv_match_id: string | null;
  cv_id: string | null;
  target_role: string | null;
  target_level: string | null;
  language_pref: 'vi' | 'en' | 'both';
  candidate_skills: LearningCandidateSkill[];
  selected_priorities: Array<{ skill_canonical: string; rank: number }>;
  selected_resources: Record<string, string[]>;
  cadence: LearningRoadmapCadenceDraft | null;
  schedule: LearningRoadmapScheduleDraft | null;
}
