import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('learning_session_progress')
@Index(['userId', 'sessionId'], { unique: true })
export class LearningSessionProgressEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @Column({ type: 'varchar', name: 'session_id', length: 160 })
  sessionId!: string;

  @Column({ type: 'jsonb', name: 'checked_checklist_items', default: () => "'{}'::jsonb" })
  checkedChecklistItems!: Record<string, string[]>;

  @Column({ type: 'jsonb', name: 'exercise_proofs', default: () => "'{}'::jsonb" })
  exerciseProofs!: Record<string, string>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
