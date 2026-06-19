import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MentorProfileStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED';

@Entity('mentor_profiles')
export class MentorProfileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Index()
  @Column({ type: 'varchar', default: 'DRAFT' })
  status!: MentorProfileStatus;

  @Column({ type: 'varchar', nullable: true })
  headline!: string | null;

  @Column({ type: 'varchar', nullable: true })
  company!: string | null;

  @Column({ type: 'varchar', name: 'short_bio', nullable: true })
  shortBio!: string | null;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'text', name: 'linkedin_url', nullable: true })
  linkedinUrl!: string | null;

  @Column({ type: 'varchar', name: 'phone_number', length: 32, nullable: true })
  phoneNumber!: string | null;

  @Column('text', { name: 'domain_tags', array: true, default: () => "'{}'" })
  domainTags!: string[];

  @Index()
  @Column({ type: 'integer', name: 'session_price_vnd', default: 50000 })
  sessionPriceVnd!: number;

  @Column({ type: 'integer', name: 'session_duration_minutes', default: 60 })
  sessionDurationMinutes!: number;

  @Column({ type: 'varchar', default: 'VND' })
  currency!: 'VND';

  @Column({ type: 'boolean', name: 'is_accepting_bookings', default: true })
  isAcceptingBookings!: boolean;

  @Index()
  @Column({ type: 'double precision', name: 'rating_average', nullable: true })
  ratingAverage!: number | null;

  @Column({ type: 'integer', name: 'review_count', default: 0 })
  reviewCount!: number;

  @Column({ type: 'integer', name: 'completed_sessions', default: 0 })
  completedSessions!: number;

  @Column({ type: 'timestamptz', name: 'submitted_at', nullable: true })
  submittedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'approved_at', nullable: true })
  approvedAt!: Date | null;

  @Column('uuid', { name: 'approved_by', nullable: true })
  approvedBy!: string | null;

  @Column({ type: 'text', name: 'rejection_reason', nullable: true })
  rejectionReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
