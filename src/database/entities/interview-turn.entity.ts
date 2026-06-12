import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { InterviewPhase } from '../../modules/interview/dto/start-interview.dto';

export type InterviewTurnModality = 'TEXT' | 'AUDIO';

@Entity('interview_turns')
@Index('idx_interview_turns_session_order_unique', ['sessionId', 'turnOrder'], { unique: true })
export class InterviewTurnEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'int', name: 'turn_order' })
  turnOrder!: number;

  @Column({ type: 'varchar', nullable: true })
  phase!: InterviewPhase | null;

  @Column({ type: 'varchar', default: 'TEXT' })
  modality!: InterviewTurnModality;

  @Column('uuid', { name: 'ai_request_id', nullable: true })
  aiRequestId!: string | null;

  @Column({ type: 'text', name: 'interviewer_message', nullable: true })
  interviewerMessage!: string | null;

  @Column({ type: 'text', name: 'interviewer_question' })
  interviewerQuestion!: string;

  @Column({ type: 'text', name: 'user_answer_text', nullable: true })
  userAnswerText!: string | null;

  @Column({ type: 'text', name: 'user_answer_transcript', nullable: true })
  userAnswerTranscript!: string | null;

  @Column({
    type: 'numeric',
    name: 'per_question_score',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  perQuestionScore!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  strengths!: unknown | null;

  @Column({ type: 'jsonb', nullable: true })
  improvements!: unknown | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'asked_at' })
  askedAt!: Date;

  @Column({ type: 'timestamptz', name: 'answered_at', nullable: true })
  answeredAt!: Date | null;

  @Column({ type: 'int', name: 'duration_seconds', nullable: true })
  durationSeconds!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
