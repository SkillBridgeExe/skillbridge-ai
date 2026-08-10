import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('interview_realtime_directives')
@Index('idx_interview_realtime_directives_session_client_unique', ['sessionId', 'clientTurnId'], {
  unique: true,
})
export class InterviewRealtimeDirectiveEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'session_id' })
  sessionId!: string;

  @Column('uuid', { name: 'turn_id', nullable: true })
  turnId!: string | null;

  @Column({ type: 'varchar', name: 'client_turn_id' })
  clientTurnId!: string;

  @Column({ type: 'varchar' })
  transcript!: string;

  @Column({ type: 'varchar' })
  modality!: 'TEXT' | 'AUDIO';

  @Column({ type: 'varchar' })
  intent!: string;

  @Column({ type: 'varchar', name: 'answer_signal' })
  answerSignal!: string;

  @Column({ type: 'varchar' })
  action!: string;

  @Column({ type: 'boolean', name: 'consumes_attempt' })
  consumesAttempt!: boolean;

  @Column({ type: 'varchar', name: 'topic_id', nullable: true })
  topicId!: string | null;

  @Column('uuid', { name: 'question_thread_id' })
  questionThreadId!: string;

  @Column({ type: 'int', name: 'difficulty_step' })
  difficultyStep!: number;

  @Column({ type: 'varchar', name: 'assistance_level' })
  assistanceLevel!: string;

  @Column({ type: 'int', name: 'score_cap', nullable: true })
  scoreCap!: number | null;

  @Column({ type: 'int', name: 'thread_score', nullable: true })
  threadScore!: number | null;

  @Column({ type: 'boolean' })
  finished!: boolean;

  @Column({ type: 'text', name: 'question_goal' })
  questionGoal!: string;

  @Column({ type: 'jsonb' })
  reasons!: string[];

  @Column({ type: 'timestamptz', name: 'speech_ended_at', nullable: true })
  speechEndedAt!: Date | null;

  @Column({ type: 'varchar', name: 'assistant_response_id', nullable: true })
  assistantResponseId!: string | null;

  @Column({ type: 'text', name: 'assistant_message', nullable: true })
  assistantMessage!: string | null;

  @Column({ type: 'text', name: 'assistant_question', nullable: true })
  assistantQuestion!: string | null;

  @Column({ type: 'timestamptz', name: 'first_audio_at', nullable: true })
  firstAudioAt!: Date | null;

  @Column({ type: 'boolean', name: 'assistant_interrupted', default: false })
  assistantInterrupted!: boolean;

  @Column({ type: 'timestamptz', name: 'committed_at', nullable: true })
  committedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
