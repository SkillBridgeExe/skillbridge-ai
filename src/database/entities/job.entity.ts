import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type JobPoolStatus = 'draft' | 'active' | 'closed' | 'expired' | 'removed';
export type JobApplicationMode = 'NATIVE' | 'EXTERNAL';
export type JobWorkMode = 'ONSITE' | 'HYBRID' | 'REMOTE';

@Entity('jobs')
export class JobEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column('uuid', { name: 'company_id' }) companyId!: string;
  @Index() @Column('uuid', { name: 'created_by_user_id', nullable: true }) createdByUserId!:
    | string
    | null;
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 320, default: () => 'gen_random_uuid()::text' })
  slug!: string;
  @Column({ type: 'varchar', length: 255 }) title!: string;
  @Index() @Column({ type: 'varchar', name: 'role_code', length: 64, nullable: true }) roleCode!:
    | string
    | null;
  @Column({ type: 'varchar', length: 255, nullable: true }) location!: string | null;
  @Column({ type: 'varchar', name: 'employment_type', length: 32, nullable: true })
  employmentType!: string | null;
  @Column({ type: 'varchar', name: 'experience_level', length: 32, nullable: true })
  experienceLevel!: string | null;
  @Column({ type: 'numeric', name: 'salary_min', precision: 12, scale: 2, nullable: true })
  salaryMin!: string | null;
  @Column({ type: 'numeric', name: 'salary_max', precision: 12, scale: 2, nullable: true })
  salaryMax!: string | null;
  @Column({ type: 'varchar', length: 8, default: 'VND' }) currency!: string;
  @Index() @Column({ type: 'varchar', length: 16, default: 'draft' }) status!: JobPoolStatus;
  @Index() @Column({ type: 'varchar', name: 'source_type', length: 16 }) sourceType!:
    | 'employer'
    | 'scraped'
    | 'imported'
    | 'feed';
  @Column({ type: 'varchar', name: 'source_name', length: 64, nullable: true }) sourceName!:
    | string
    | null;
  @Column({ type: 'text', name: 'source_url', nullable: true }) sourceUrl!: string | null;
  @Column({ type: 'varchar', name: 'external_id', length: 255, nullable: true }) externalId!:
    | string
    | null;
  @Column({ type: 'varchar', name: 'content_hash', length: 64, nullable: true }) contentHash!:
    | string
    | null;
  @Column('uuid', { name: 'canonical_job_id', nullable: true }) canonicalJobId!: string | null;
  @Column('uuid', { name: 'current_published_version_id', nullable: true })
  currentPublishedVersionId!: string | null;
  @Index()
  @Column({ type: 'varchar', name: 'application_mode', length: 16, default: 'EXTERNAL' })
  applicationMode!: JobApplicationMode;
  @Index()
  @Column({ type: 'varchar', name: 'work_mode', length: 16, nullable: true })
  workMode!: JobWorkMode | null;
  @Index()
  @Column({ type: 'varchar', name: 'primary_city_code', length: 64, nullable: true })
  primaryCityCode!: string | null;
  @Column('text', { name: 'location_city_codes', array: true, default: () => "'{}'" })
  locationCityCodes!: string[];
  @Column({ type: 'varchar', name: 'salary_period', length: 16, nullable: true }) salaryPeriod!:
    | 'MONTH'
    | 'YEAR'
    | null;
  @Column({ type: 'boolean', name: 'salary_visible', default: true }) salaryVisible!: boolean;
  @Column({ type: 'boolean', name: 'salary_negotiable', default: false })
  salaryNegotiable!: boolean;
  @Column({ type: 'integer', name: 'openings_count', default: 1 }) openingsCount!: number;
  @Column({ type: 'numeric', name: 'min_years_experience', precision: 4, scale: 1, nullable: true })
  minYearsExperience!: string | null;
  @Column({ type: 'numeric', name: 'max_years_experience', precision: 4, scale: 1, nullable: true })
  maxYearsExperience!: string | null;
  @Column({ type: 'timestamptz', name: 'posted_at', nullable: true }) postedAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'last_seen_at', nullable: true }) lastSeenAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true }) expiresAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'closed_at', nullable: true }) closedAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'removed_at', nullable: true }) removedAt!: Date | null;
  @Column('uuid', { name: 'removed_by_user_id', nullable: true }) removedByUserId!: string | null;
  @Column({ type: 'text', name: 'removal_reason', nullable: true }) removalReason!: string | null;
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
