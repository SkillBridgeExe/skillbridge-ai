import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type LearningEvidenceStatus = 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';

@Entity('learning_evidence')
@Index(['sessionId', 'userId', 'taskId'], { unique: true })
export class LearningEvidenceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 180, name: 'task_id' })
  taskId!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'varchar', length: 16, default: 'SUBMITTED' })
  status!: LearningEvidenceStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
