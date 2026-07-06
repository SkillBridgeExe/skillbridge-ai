import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('mentor_availability_templates')
@Index(['mentorProfileId', 'dayOfWeek', 'startMinute'])
export class MentorAvailabilityTemplateEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'mentor_profile_id' })
  mentorProfileId!: string;

  @Column({ type: 'integer', name: 'day_of_week' })
  dayOfWeek!: number;

  @Column({ type: 'integer', name: 'start_minute' })
  startMinute!: number;

  @Column({ type: 'integer', name: 'end_minute' })
  endMinute!: number;

  @Column({ type: 'integer', name: 'buffer_minutes', default: 0 })
  bufferMinutes!: number;

  @Column({ type: 'varchar', default: 'Asia/Ho_Chi_Minh' })
  timezone!: string;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
