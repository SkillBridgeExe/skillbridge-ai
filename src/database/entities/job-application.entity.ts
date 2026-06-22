import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CvKind } from './cv.entity';

export type JobApplicationMatchStatus = 'PENDING' | 'READY' | 'FAILED';
export type JobApplicationStatus =
  | 'SUBMITTED'
  | 'IN_REVIEW'
  | 'SHORTLISTED'
  | 'REJECTED'
  | 'WITHDRAWN';

@Entity('job_applications')
@Index(['jobId', 'candidateUserId'], { unique: true })
export class JobApplicationEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column('uuid', { name: 'job_id' }) jobId!: string;
  @Column('uuid', { name: 'job_version_id' }) jobVersionId!: string;
  @Index() @Column('uuid', { name: 'candidate_user_id' }) candidateUserId!: string;
  @Column('uuid', { name: 'source_cv_id', nullable: true }) sourceCvId!: string | null;
  @Index()
  @Column({ type: 'varchar', length: 24, default: 'SUBMITTED' })
  status!: JobApplicationStatus;
  @Column({ type: 'text', name: 'cover_note', nullable: true }) coverNote!: string | null;
  @Column({ type: 'varchar', name: 'candidate_name', length: 255 }) candidateName!: string;
  @Column({ type: 'varchar', name: 'candidate_email', length: 320 }) candidateEmail!: string;
  @Column({ type: 'varchar', name: 'candidate_phone', length: 32, nullable: true })
  candidatePhone!: string | null;
  @Column({ type: 'varchar', name: 'consent_version', length: 64 }) consentVersion!: string;
  @Column({ type: 'timestamptz', name: 'consent_accepted_at' }) consentAcceptedAt!: Date;
  @Column({ type: 'text', name: 'cv_storage_object_key', nullable: true }) cvStorageObjectKey!:
    | string
    | null;
  @Column({ type: 'varchar', name: 'cv_original_file_name', length: 512, nullable: true })
  cvOriginalFileName!: string | null;
  @Column({ type: 'varchar', name: 'cv_content_type', length: 128, nullable: true })
  cvContentType!: string | null;
  @Column({ type: 'integer', name: 'cv_file_size', nullable: true }) cvFileSize!: number | null;
  @Column({ type: 'varchar', name: 'cv_checksum_sha256', length: 64, nullable: true })
  cvChecksumSha256!: string | null;
  @Column({ type: 'varchar', name: 'cv_kind', length: 16, nullable: true }) cvKind!: CvKind | null;
  @Column({ type: 'jsonb', name: 'cv_skills_snapshot', default: () => "'[]'::jsonb" })
  cvSkillsSnapshot!: unknown[];
  @Column({ type: 'varchar', name: 'match_status', length: 16, default: 'PENDING' })
  matchStatus!: JobApplicationMatchStatus;
  @Column({ type: 'numeric', name: 'match_score', precision: 5, scale: 2, nullable: true })
  matchScore!: string | null;
  @Column({ type: 'varchar', name: 'match_scoring_version', length: 64, nullable: true })
  matchScoringVersion!: string | null;
  @Column({ type: 'jsonb', name: 'match_result', nullable: true }) matchResult!: unknown | null;
  @Column({ type: 'timestamptz', name: 'match_computed_at', nullable: true })
  matchComputedAt!: Date | null;
  @Column({ type: 'varchar', name: 'match_error_code', length: 64, nullable: true })
  matchErrorCode!: string | null;
  @Column({ type: 'timestamptz', name: 'first_viewed_at', nullable: true })
  firstViewedAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'submitted_at', default: () => 'now()' }) submittedAt!: Date;
  @Column({ type: 'timestamptz', name: 'withdrawn_at', nullable: true }) withdrawnAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'terminal_at', nullable: true }) terminalAt!: Date | null;
  @Index()
  @Column({ type: 'timestamptz', name: 'pii_purge_after', nullable: true })
  piiPurgeAfter!: Date | null;
  @Column({ type: 'timestamptz', name: 'pii_purged_at', nullable: true }) piiPurgedAt!: Date | null;
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
