import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MentorBookingStatus =
  | 'PENDING_DEPOSIT'
  | 'AWAITING_REMAINING'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

export type MentorBookingRefundStatus = 'NOT_REQUIRED' | 'PENDING' | 'PROCESSED' | 'REJECTED';

@Entity('mentor_bookings')
export class MentorBookingEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'student_id' })
  studentId!: string;

  @Index()
  @Column('uuid', { name: 'mentor_id' })
  mentorId!: string;

  @Index()
  @Column('uuid', { name: 'mentor_profile_id' })
  mentorProfileId!: string;

  @Index({ unique: true })
  @Column('uuid', { name: 'availability_slot_id' })
  availabilitySlotId!: string;

  @Column({ type: 'varchar', name: 'plan_code', nullable: true })
  planCode!: string | null;

  @Index()
  @Column({ type: 'varchar' })
  status!: MentorBookingStatus;

  @Column({ type: 'jsonb', name: 'package_snapshot', nullable: true })
  packageSnapshot!: unknown | null;

  @Column({ type: 'timestamptz', name: 'slot_start', nullable: true })
  slotStart!: Date | null;

  @Column({ type: 'timestamptz', name: 'slot_end', nullable: true })
  slotEnd!: Date | null;

  @Column({ type: 'integer', name: 'total_amount_vnd' })
  totalAmountVnd!: number;

  @Column({ type: 'integer', name: 'deposit_amount_vnd' })
  depositAmountVnd!: number;

  @Column({ type: 'integer', name: 'remaining_amount_vnd' })
  remainingAmountVnd!: number;

  @Column('uuid', { name: 'deposit_payment_order_id', nullable: true })
  depositPaymentOrderId!: string | null;

  @Column('uuid', { name: 'remaining_payment_order_id', nullable: true })
  remainingPaymentOrderId!: string | null;

  @Column({ type: 'timestamptz', name: 'accepted_at', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'remaining_due_at', nullable: true })
  remainingDueAt!: Date | null;

  @Column({ type: 'text', name: 'meeting_url', nullable: true })
  meetingUrl!: string | null;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;

  @Column('uuid', { name: 'cancelled_by', nullable: true })
  cancelledBy!: string | null;

  @Column({ type: 'text', name: 'cancellation_reason', nullable: true })
  cancellationReason!: string | null;

  @Index()
  @Column({ type: 'varchar', name: 'refund_status', default: 'NOT_REQUIRED' })
  refundStatus!: MentorBookingRefundStatus;

  @Column({ type: 'text', name: 'refund_note', nullable: true })
  refundNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
