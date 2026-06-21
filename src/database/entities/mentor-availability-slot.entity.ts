import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MentorAvailabilitySlotStatus = 'OPEN' | 'HELD' | 'BOOKED' | 'BLOCKED';

@Entity('mentor_availability_slots')
@Index(['mentorProfileId', 'startsAt'])
export class MentorAvailabilitySlotEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'mentor_profile_id' })
  mentorProfileId!: string;

  @Column({ type: 'timestamptz', name: 'starts_at' })
  startsAt!: Date;

  @Column({ type: 'timestamptz', name: 'ends_at' })
  endsAt!: Date;

  @Index()
  @Column({ type: 'varchar', default: 'OPEN' })
  status!: MentorAvailabilitySlotStatus;

  @Column('uuid', { name: 'held_by_booking_id', nullable: true })
  heldByBookingId!: string | null;

  @Column({ type: 'timestamptz', name: 'hold_expires_at', nullable: true })
  holdExpiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
