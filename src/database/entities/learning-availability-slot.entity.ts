import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('learning_availability_slots')
@Index(['profileId', 'isoWeekday', 'startTime'], { unique: true })
export class LearningAvailabilitySlotEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'profile_id' })
  profileId!: string;

  @Column({ type: 'smallint', name: 'iso_weekday' })
  isoWeekday!: number;

  @Column({ type: 'time', name: 'start_time' })
  startTime!: string;

  @Column({ type: 'int', name: 'duration_minutes' })
  durationMinutes!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
