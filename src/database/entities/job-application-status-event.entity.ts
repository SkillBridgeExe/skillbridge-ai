import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { JobApplicationStatus } from '../../platform/business-jobs/job-domain';

export type ApplicationNotificationType = 'NONE' | 'NEW_APPLICATION' | 'APPLICATION_STATUS_CHANGED';
export type ApplicationNotificationStatus = 'NOT_REQUIRED' | 'PENDING' | 'SENT' | 'FAILED';

@Entity('job_application_status_events')
export class JobApplicationStatusEventEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column('uuid', { name: 'application_id' }) applicationId!: string;
  @Column({ type: 'varchar', name: 'from_status', length: 24, nullable: true })
  fromStatus!: JobApplicationStatus | null;
  @Column({ type: 'varchar', name: 'to_status', length: 24 }) toStatus!: JobApplicationStatus;
  @Column('uuid', { name: 'actor_user_id', nullable: true }) actorUserId!: string | null;
  @Column({ type: 'text', name: 'internal_note', nullable: true }) internalNote!: string | null;
  @Column({ type: 'varchar', name: 'notification_type', length: 40, default: 'NONE' })
  notificationType!: ApplicationNotificationType;
  @Index()
  @Column({ type: 'varchar', name: 'notification_status', length: 24, default: 'NOT_REQUIRED' })
  notificationStatus!: ApplicationNotificationStatus;
  @Column({ type: 'integer', name: 'notification_attempt_count', default: 0 })
  notificationAttemptCount!: number;
  @Column({ type: 'timestamptz', name: 'notification_next_attempt_at', nullable: true })
  notificationNextAttemptAt!: Date | null;
  @Column({ type: 'timestamptz', name: 'notification_sent_at', nullable: true })
  notificationSentAt!: Date | null;
  @Column({ type: 'varchar', name: 'notification_error_code', length: 64, nullable: true })
  notificationErrorCode!: string | null;
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;
}
