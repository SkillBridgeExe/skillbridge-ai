import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('learning_quiz_attempts')
@Index(['sessionId', 'userId', 'questionId', 'attemptNo'], { unique: true })
export class LearningQuizAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 180, name: 'question_id' })
  questionId!: string;

  @Column({ type: 'int', name: 'selected_option_index' })
  selectedOptionIndex!: number;

  @Column({ type: 'boolean', name: 'is_correct' })
  isCorrect!: boolean;

  @Column({ type: 'int', name: 'attempt_no' })
  attemptNo!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'answered_at' })
  answeredAt!: Date;
}
