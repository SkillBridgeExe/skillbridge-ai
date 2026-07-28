import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type LearningRoadmapIntent = 'JD_APPLICATION' | 'CAREER_ROLE';
export type LearningRoadmapStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface LearningCandidateSkill {
  skill_canonical: string;
  display_name: string;
  system_priority: number;
  rationale: string;
  prerequisites: string[];
}

export interface LearningRoadmapScheduleDraft {
  timezone: string;
  deadline: string;
  session_minutes: 30 | 45 | 60 | 90;
  slots: Array<{
    iso_weekday: number;
    start_time: string;
    duration_minutes: number;
  }>;
}

export interface LearningRoadmapCadenceDraft {
  timezone: string;
  start_date: string;
  study_days_per_week: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  session_minutes: 30 | 45 | 60 | 90;
}

export interface LearningRoadmapDraftConfig {
  language_pref: 'vi' | 'en' | 'both';
  source_target_role?: string | null;
  source_cv_id?: string | null;
  candidate_skills: LearningCandidateSkill[];
  selected_priorities?: Array<{ skill_canonical: string; rank: number }>;
  selected_resources?: Record<string, string[]>;
  cadence?: LearningRoadmapCadenceDraft;
  schedule?: LearningRoadmapScheduleDraft;
}

@Entity('learning_roadmaps')
@Index(['userId', 'status'])
@Index(['userId'], { unique: true, where: `"status" = 'ACTIVE'` })
@Check(`"intent" IN ('JD_APPLICATION', 'CAREER_ROLE')`)
@Check(`"status" IN ('DRAFT', 'ACTIVE', 'ARCHIVED')`)
@Check(
  `("intent" = 'JD_APPLICATION' AND "cv_match_id" IS NOT NULL AND "target_role" IS NULL) OR ` +
    `("intent" = 'CAREER_ROLE' AND "cv_match_id" IS NULL AND "target_role" IS NOT NULL)`,
)
export class LearningRoadmapEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 32 })
  intent!: LearningRoadmapIntent;

  @Column({ type: 'varchar', length: 16, default: 'DRAFT' })
  status!: LearningRoadmapStatus;

  @Column({ type: 'uuid', name: 'cv_match_id', nullable: true })
  cvMatchId!: string | null;

  @Column({ type: 'varchar', length: 100, name: 'target_role', nullable: true })
  targetRole!: string | null;

  @Column({ type: 'varchar', length: 24, name: 'target_level', nullable: true })
  targetLevel!: string | null;

  @Column({ type: 'uuid', name: 'active_version_id', nullable: true })
  activeVersionId!: string | null;

  @Column({ type: 'int', default: 0 })
  revision!: number;

  @Column({ type: 'jsonb', name: 'draft_config', default: () => "'{}'::jsonb" })
  draftConfig!: LearningRoadmapDraftConfig;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
