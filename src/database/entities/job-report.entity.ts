import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type JobReportReason = 'SCAM' | 'MISLEADING' | 'DISCRIMINATION' | 'EXPIRED' | 'OTHER';
export type JobReportStatus = 'OPEN' | 'DISMISSED' | 'ACTIONED';

@Entity('job_reports')
@Index(['jobId', 'reporterUserId'], { unique: true })
export class JobReportEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column('uuid', { name: 'job_id' }) jobId!: string;
  @Column('uuid', { name: 'reporter_user_id' }) reporterUserId!: string;
  @Column({ type: 'varchar', name: 'reason_code', length: 24 }) reasonCode!: JobReportReason;
  @Column({ type: 'text', nullable: true }) details!: string | null;
  @Index() @Column({ type: 'varchar', length: 16, default: 'OPEN' }) status!: JobReportStatus;
  @Column('uuid', { name: 'resolved_by_user_id', nullable: true }) resolvedByUserId!: string | null;
  @Column({ type: 'text', name: 'resolution_note', nullable: true }) resolutionNote!: string | null;
  @Column({ type: 'timestamptz', name: 'resolved_at', nullable: true }) resolvedAt!: Date | null;
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
