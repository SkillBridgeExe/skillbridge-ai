import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type BusinessProfileStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'VERIFIED'
  | 'REJECTED'
  | 'SUSPENDED';

@Entity('business_profiles')
export class BusinessProfileEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index({ unique: true }) @Column('uuid', { name: 'user_id' }) userId!: string;
  @Index({ unique: true }) @Column('uuid', { name: 'company_id' }) companyId!: string;
  @Index()
  @Column({ type: 'varchar', length: 24, default: 'DRAFT' })
  status!: BusinessProfileStatus;
  @Column({ type: 'varchar', name: 'contact_name', length: 255, nullable: true }) contactName!:
    | string
    | null;
  @Column({ type: 'varchar', name: 'contact_phone', length: 32, nullable: true }) contactPhone!:
    | string
    | null;
  @Column({ type: 'varchar', name: 'work_email', length: 320, nullable: true }) workEmail!:
    | string
    | null;
  @Index({ unique: true })
  @Column({ type: 'varchar', name: 'work_email_normalized', length: 320, nullable: true })
  workEmailNormalized!: string | null;
  @Column({ type: 'varchar', name: 'work_email_domain', length: 255, nullable: true })
  workEmailDomain!: string | null;
  @Column({ type: 'timestamptz', name: 'work_email_verified_at', nullable: true })
  workEmailVerifiedAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'submitted_at', nullable: true }) submittedAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'reviewed_at', nullable: true }) reviewedAt!: Date | null;
  @Column('uuid', { name: 'reviewed_by_user_id', nullable: true }) reviewedByUserId!: string | null;
  @Column({ type: 'text', name: 'rejection_reason', nullable: true }) rejectionReason!:
    | string
    | null;
  @Column({ type: 'text', name: 'suspension_reason', nullable: true }) suspensionReason!:
    | string
    | null;
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
