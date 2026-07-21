import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('learning_sessions')
@Index(['moduleId', 'sequence'], { unique: true })
export class LearningSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'module_id' })
  moduleId!: string;

  @Column({ type: 'int' })
  sequence!: number;

  @Column({ type: 'varchar', length: 240 })
  title!: string;

  @Column({ type: 'timestamptz', name: 'scheduled_start_at' })
  scheduledStartAt!: Date;

  @Column({ type: 'int', name: 'duration_minutes' })
  durationMinutes!: number;

  @Column({ type: 'jsonb', name: 'required_tasks', default: () => "'[]'::jsonb" })
  requiredTasks!: Array<Record<string, unknown>>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
