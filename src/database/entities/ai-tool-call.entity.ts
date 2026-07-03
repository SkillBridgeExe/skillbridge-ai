import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type AiToolCallStatus = 'SUCCESS' | 'FAILED' | 'PENDING';

@Entity('ai_tool_calls')
@Index(['userId', 'toolName', 'createdAt'])
export class AiToolCallEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'ai_request_id', nullable: true })
  aiRequestId!: string | null;

  @Index()
  @Column('uuid', { name: 'user_id', nullable: true })
  userId!: string | null;

  @Index()
  @Column({ type: 'varchar', name: 'tool_name' })
  toolName!: string;

  @Column({ type: 'varchar', length: 64, name: 'args_hash' })
  argsHash!: string;

  @Column({ type: 'varchar' })
  status!: AiToolCallStatus;

  @Column({ type: 'int', name: 'latency_ms', nullable: true })
  latencyMs!: number | null;

  @Column({ type: 'text', name: 'error_message', nullable: true })
  errorMessage!: string | null;

  @Index()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
