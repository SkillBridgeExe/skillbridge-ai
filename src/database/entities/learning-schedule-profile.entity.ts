import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('learning_schedule_profiles')
@Index(['userId'], { unique: true, where: 'is_default = true' })
export class LearningScheduleProfileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 80, default: 'Default' })
  name!: string;

  @Column({ type: 'varchar', length: 80 })
  timezone!: string;

  @Column({ type: 'int', name: 'session_minutes' })
  sessionMinutes!: number;

  @Column({ type: 'boolean', name: 'is_default', default: true })
  isDefault!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
