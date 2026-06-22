import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { JobWorkMode } from './job.entity';

export type JobPostVersionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
export interface JobLocationSnapshot {
  cityCode: string;
  countryCode: string;
  addressLine: string;
  isPrimary: boolean;
}
export interface JobSkillSnapshot {
  skillId: string;
  canonicalName: string;
  importance: 'REQUIRED' | 'NICE_TO_HAVE';
  minLevel: number | null;
  source: 'AUTO' | 'BUSINESS';
  confidence: number | null;
  rawText: string | null;
}

@Entity('job_post_versions')
@Index(['jobId', 'versionNo'], { unique: true })
export class JobPostVersionEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column('uuid', { name: 'job_id' }) jobId!: string;
  @Column({ type: 'integer', name: 'version_no' }) versionNo!: number;
  @Index() @Column({ type: 'varchar', length: 16, default: 'DRAFT' }) status!: JobPostVersionStatus;
  @Column({ type: 'integer', default: 1 }) revision!: number;
  @Column('uuid', { name: 'created_by_user_id', nullable: true }) createdByUserId!: string | null;
  @Column({ type: 'varchar', length: 255 }) title!: string;
  @Column({ type: 'varchar', name: 'role_code', length: 64, nullable: true }) roleCode!:
    | string
    | null;
  @Column({ type: 'varchar', name: 'employment_type', length: 32, nullable: true })
  employmentType!: string | null;
  @Column({ type: 'varchar', name: 'experience_level', length: 32, nullable: true })
  experienceLevel!: string | null;
  @Column({ type: 'numeric', name: 'min_years_experience', precision: 4, scale: 1, nullable: true })
  minYearsExperience!: string | null;
  @Column({ type: 'numeric', name: 'max_years_experience', precision: 4, scale: 1, nullable: true })
  maxYearsExperience!: string | null;
  @Column({ type: 'varchar', name: 'work_mode', length: 16, nullable: true })
  workMode!: JobWorkMode | null;
  @Column({ type: 'integer', name: 'openings_count', default: 1 }) openingsCount!: number;
  @Column({ type: 'numeric', name: 'salary_min', precision: 12, scale: 2, nullable: true })
  salaryMin!: string | null;
  @Column({ type: 'numeric', name: 'salary_max', precision: 12, scale: 2, nullable: true })
  salaryMax!: string | null;
  @Column({ type: 'varchar', length: 8, default: 'VND' }) currency!: string;
  @Column({ type: 'varchar', name: 'salary_period', length: 16, nullable: true }) salaryPeriod!:
    | 'MONTH'
    | 'YEAR'
    | null;
  @Column({ type: 'boolean', name: 'salary_visible', default: true }) salaryVisible!: boolean;
  @Column({ type: 'boolean', name: 'salary_negotiable', default: false })
  salaryNegotiable!: boolean;
  @Column({ type: 'varchar', name: 'education_level', length: 32, nullable: true })
  educationLevel!: string | null;
  @Column({ type: 'varchar', name: 'language_code', length: 16, nullable: true }) languageCode!:
    | string
    | null;
  @Column({ type: 'timestamptz', name: 'application_deadline', nullable: true })
  applicationDeadline!: Date | null;
  @Column({ type: 'text', nullable: true }) summary!: string | null;
  @Column('text', { array: true, default: () => "'{}'" }) responsibilities!: string[];
  @Column('text', { array: true, default: () => "'{}'" }) requirements!: string[];
  @Column('text', { name: 'nice_to_have', array: true, default: () => "'{}'" })
  niceToHave!: string[];
  @Column('text', { array: true, default: () => "'{}'" }) benefits!: string[];
  @Column('text', { name: 'interview_process', array: true, default: () => "'{}'" })
  interviewProcess!: string[];
  @Column({ type: 'text', name: 'working_time', nullable: true }) workingTime!: string | null;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) locations!: JobLocationSnapshot[];
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) skills!: JobSkillSnapshot[];
  @Column({ type: 'timestamptz', name: 'skills_confirmed_at', nullable: true })
  skillsConfirmedAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'published_at', nullable: true }) publishedAt!: Date | null;
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
