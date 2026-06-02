import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type AiRequestStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

@Entity('ai_requests')
export class AiRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id', nullable: true })
  userId!: string | null;

  @Index()
  @Column('uuid', { name: 'ai_job_id', nullable: true })
  aiJobId!: string | null;

  @Index()
  @Column('uuid', { name: 'model_id', nullable: true })
  modelId!: string | null;

  @Index()
  @Column('uuid', { name: 'prompt_template_id', nullable: true })
  promptTemplateId!: string | null;

  @Index()
  @Column({ type: 'varchar', name: 'request_type' })
  requestType!: string;

  @Column({ type: 'jsonb', name: 'request_payload', nullable: true })
  requestPayload!: unknown | null;

  @Column({ type: 'int', name: 'prompt_tokens', nullable: true })
  promptTokens!: number | null;

  @Column({ type: 'int', name: 'completion_tokens', nullable: true })
  completionTokens!: number | null;

  @Column({ type: 'int', name: 'total_tokens', nullable: true })
  totalTokens!: number | null;

  @Column({ type: 'numeric', name: 'estimated_cost', precision: 12, scale: 6, nullable: true })
  estimatedCost!: string | null;

  @Column({ type: 'int', name: 'latency_ms', nullable: true })
  latencyMs!: number | null;

  @Index()
  @Column({ type: 'varchar', default: 'PENDING' })
  status!: AiRequestStatus;

  @Column({ type: 'text', name: 'error_message', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
