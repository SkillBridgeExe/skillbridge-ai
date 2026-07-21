import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type LearningModuleFeasibility = 'FEASIBLE' | 'DEFERRED';

@Entity('learning_modules')
@Index(['versionId', 'skillCanonical'], { unique: true })
export class LearningModuleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'version_id' })
  versionId!: string;

  @Column({ type: 'uuid', name: 'skill_id', nullable: true })
  skillId!: string | null;

  @Column({ type: 'varchar', length: 160, name: 'skill_canonical' })
  skillCanonical!: string;

  @Column({ type: 'varchar', length: 200, name: 'display_name' })
  displayName!: string;

  @Column({ type: 'int' })
  rank!: number;

  @Column({ type: 'numeric', precision: 8, scale: 3, name: 'system_priority' })
  systemPriority!: string;

  @Column({ type: 'int', name: 'user_priority', nullable: true })
  userPriority!: number | null;

  @Column({ type: 'text' })
  rationale!: string;

  @Column({ type: 'jsonb', name: 'prerequisite_canonicals', default: () => "'[]'::jsonb" })
  prerequisiteCanonicals!: string[];

  @Column({ type: 'int', name: 'estimated_minutes' })
  estimatedMinutes!: number;

  @Column({ type: 'varchar', length: 16 })
  feasibility!: LearningModuleFeasibility;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
