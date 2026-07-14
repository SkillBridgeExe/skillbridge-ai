import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'learning_roadmaps' })
@Index('idx_learning_roadmaps_user_active', ['userId', 'active'])
export class LearningRoadmapEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'jsonb', name: 'source_refs', default: () => "'[]'::jsonb" })
  sourceRefs!: unknown[];

  @Column({ type: 'jsonb', name: 'composed_roadmap' })
  composedRoadmap!: unknown;

  @Column({ type: 'jsonb', name: 'schedule', default: () => "'[]'::jsonb" })
  schedule!: unknown[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
