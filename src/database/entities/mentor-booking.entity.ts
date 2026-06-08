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
  | 'AWAITING_MENTOR_ACCEPT'
  | 'AWAITING_REMAINING'
  | 'PAID'
  | 'CANCELLED';

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

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
