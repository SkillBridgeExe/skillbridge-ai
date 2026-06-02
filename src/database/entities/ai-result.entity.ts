import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_results')
export class AiResultEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'ai_request_id' })
  aiRequestId!: string;

  @Index()
  @Column('uuid', { name: 'user_id', nullable: true })
  userId!: string | null;

  @Index()
  @Column({ type: 'varchar', name: 'result_type', nullable: true })
  resultType!: string | null;

  @Column({ type: 'jsonb', name: 'raw_response', nullable: true })
  rawResponse!: unknown | null;

  @Column({ type: 'jsonb', name: 'parsed_response', nullable: true })
  parsedResponse!: unknown | null;

  @Column({ type: 'numeric', name: 'total_score', precision: 5, scale: 2, nullable: true })
  totalScore!: string | null;

  @Column({ type: 'numeric', name: 'confidence_score', precision: 5, scale: 2, nullable: true })
  confidenceScore!: string | null;

  @Column({ type: 'int', name: 'token_usage', nullable: true })
  tokenUsage!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
