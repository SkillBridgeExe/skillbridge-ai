import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type InterviewMode = 'TEXT' | 'VOICE' | 'HYBRID';
export type InterviewStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
export type InterviewType = 'HR' | 'TECHNICAL' | 'MIXED';

@Entity('interview_sessions')
export class InterviewSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Index()
  @Column('uuid', { name: 'cv_id', nullable: true })
  cvId!: string | null;

  @Index()
  @Column('uuid', { name: 'job_description_id', nullable: true })
  jobDescriptionId!: string | null;

  @Index()
  @Column('uuid', { name: 'cv_match_id', nullable: true })
  cvMatchId!: string | null;

  @Column({ type: 'varchar', name: 'target_role' })
  targetRole!: string;

  @Column({ type: 'varchar', default: 'vi' })
  language!: string;

  @Column({ type: 'varchar' })
  mode!: InterviewMode;

  @Column({ type: 'varchar', name: 'interview_type' })
  interviewType!: InterviewType;

  @Index()
  @Column({ type: 'varchar', default: 'IN_PROGRESS' })
  status!: InterviewStatus;

  @Column({ type: 'varchar', name: 'realtime_provider', nullable: true })
  realtimeProvider!: string | null;

  @Column({ type: 'varchar', name: 'realtime_model', nullable: true })
  realtimeModel!: string | null;

  @Column({ type: 'varchar', name: 'realtime_session_id', nullable: true })
  realtimeSessionId!: string | null;

  @Column('uuid', { name: 'final_ai_request_id', nullable: true })
  finalAiRequestId!: string | null;

  @Column('uuid', { name: 'final_ai_result_id', nullable: true })
  finalAiResultId!: string | null;

  @Column({ type: 'int', name: 'total_questions_planned', nullable: true })
  totalQuestionsPlanned!: number | null;

  @Column({ type: 'int', name: 'max_duration_seconds', default: 600 })
  maxDurationSeconds!: number;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'numeric', name: 'overall_score', precision: 5, scale: 2, nullable: true })
  overallScore!: string | null;

  @Column({ type: 'numeric', name: 'semantic_score', precision: 5, scale: 2, nullable: true })
  semanticScore!: string | null;

  @Column({ type: 'numeric', name: 'llm_score', precision: 5, scale: 2, nullable: true })
  llmScore!: string | null;

  @Column({ type: 'numeric', name: 'communication_score', precision: 5, scale: 2, nullable: true })
  communicationScore!: string | null;

  @Column({ type: 'jsonb', name: 'ai_feedback', nullable: true })
  aiFeedback!: unknown | null;

  @Column({ type: 'jsonb', name: 'context_snapshot', nullable: true })
  contextSnapshot!: unknown | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'started_at' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', name: 'ended_at', nullable: true })
  endedAt!: Date | null;

  @Column({ type: 'int', name: 'duration_seconds', nullable: true })
  durationSeconds!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
