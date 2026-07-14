export type RoadmapSourceType = 'jd_match' | 'role_baseline';

export interface RoadmapSourceRefDto {
  type: RoadmapSourceType;
  id: string;
  label?: string;
  reason: string;
}

export interface RoadmapSkillOptionDto {
  skill_canonical: string;
  display_name: string;
  priority: number;
  estimated_hours: number;
  required_level?: number | null;
  cv_level?: number | null;
  importance?: 'REQUIRED' | 'PREFERRED' | 'NICE_TO_HAVE';
  selected_by_default: boolean;
  source: RoadmapSourceRefDto;
  resources?: RoadmapResourceOptionDto[];
}

export interface RoadmapResourceOptionDto {
  id: string;
  source_type: string;
  title: string;
  url?: string;
  is_internal: boolean;
  description?: string;
  duration_minutes: number;
  outcome_type: string;
}

export interface RoadmapOptionsResponseDto {
  source: RoadmapSourceRefDto;
  options: RoadmapSkillOptionDto[];
  no_learning_gaps?: boolean;
}
