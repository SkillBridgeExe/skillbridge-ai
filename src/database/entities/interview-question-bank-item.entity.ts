import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { InterviewType } from './interview-session.entity';
import { InterviewFocusArea } from '../../modules/interview/interview-planner';
import { InterviewPhase } from '../../modules/interview/interview-agenda';
import { Dimension } from '../../modules/interview/interview-scoring';

export type InterviewQuestionLanguage = 'vi' | 'en';
export type InterviewQuestionReviewStatus = 'draft' | 'mentor_reviewed' | 'disabled';
export type InterviewQuestionSourceKind =
  | 'authored_from_taxonomy'
  | 'open_source_adapted'
  | 'internal_rubric';

@Entity('interview_question_bank_items')
@Index('uq_interview_question_bank_key_language', ['questionKey', 'language'], { unique: true })
@Index('idx_interview_question_bank_lookup', [
  'active',
  'language',
  'targetRole',
  'interviewType',
  'phase',
  'skillCanonical',
])
export class InterviewQuestionBankItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', name: 'question_key' })
  questionKey!: string;

  @Column({ type: 'varchar' })
  language!: InterviewQuestionLanguage;

  @Column({ type: 'varchar', name: 'target_role' })
  targetRole!: string;

  @Column({ type: 'varchar', name: 'interview_type' })
  interviewType!: InterviewType;

  @Column({ type: 'varchar' })
  phase!: InterviewPhase;

  @Column({ type: 'varchar', name: 'skill_canonical', nullable: true })
  skillCanonical!: string | null;

  @Column({ type: 'varchar', name: 'focus_type', nullable: true })
  focusType!: InterviewFocusArea['focus_type'] | null;

  @Column({ type: 'varchar', nullable: true })
  seniority!: string | null;

  @Column({ type: 'int' })
  difficulty!: number;

  @Column({ type: 'text', name: 'question_text' })
  questionText!: string;

  @Column({ type: 'jsonb', name: 'expected_signals' })
  expectedSignals!: string[];

  @Column({ type: 'jsonb', name: 'rubric_dimensions' })
  rubricDimensions!: Dimension[];

  @Column({ type: 'varchar', name: 'source_kind' })
  sourceKind!: InterviewQuestionSourceKind;

  @Column({ type: 'text', name: 'source_url', nullable: true })
  sourceUrl!: string | null;

  @Column({ type: 'text', name: 'source_basis' })
  sourceBasis!: string;

  @Column({ type: 'varchar' })
  license!: string;

  @Column({ type: 'text', nullable: true })
  attribution!: string | null;

  @Column({ type: 'varchar', name: 'review_status' })
  reviewStatus!: InterviewQuestionReviewStatus;

  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
