import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type CvMatchTargetType = 'JOB_DESCRIPTION';

@Entity('cv_matches')
export class CvMatchEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'cv_id' })
  cvId!: string;

  @Index()
  @Column({ type: 'varchar', name: 'target_type' })
  targetType!: CvMatchTargetType;

  @Index()
  @Column('uuid', { name: 'job_description_id', nullable: true })
  jobDescriptionId!: string | null;

  @Index()
  @Column('uuid', { name: 'ai_result_id', nullable: true })
  aiResultId!: string | null;

  @Column({ type: 'numeric', name: 'overall_score', precision: 5, scale: 2, nullable: true })
  overallScore!: string | null;

  @Column({ type: 'numeric', name: 'semantic_score', precision: 5, scale: 2, nullable: true })
  semanticScore!: string | null;

  @Column({ type: 'numeric', name: 'ats_score', precision: 5, scale: 2, nullable: true })
  atsScore!: string | null;

  @Column({ type: 'numeric', name: 'llm_score', precision: 5, scale: 2, nullable: true })
  llmScore!: string | null;

  @Column({
    type: 'numeric',
    name: 'rule_engine_score',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  ruleEngineScore!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  strengths!: unknown | null;

  @Column({ type: 'jsonb', nullable: true })
  weaknesses!: unknown | null;

  @Column({ type: 'jsonb', nullable: true })
  suggestions!: unknown | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
