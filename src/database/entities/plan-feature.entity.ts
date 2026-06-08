import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const BILLING_FEATURE_KEYS = [
  'cv_review',
  'cv_upload',
  'cv_builder_create',
  'cv_builder_rewrite',
  'cv_builder_render_pdf',
  'cv_jd_match',
  'job_recommendation',
  'interview_session',
  'roadmap_generate',
] as const;

export type BillingFeatureKey = (typeof BILLING_FEATURE_KEYS)[number];

@Entity('plan_features')
@Index('idx_plan_features_plan_feature_unique', ['planCode', 'featureKey'], { unique: true })
export class PlanFeatureEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', name: 'plan_code' })
  planCode!: string;

  @Index()
  @Column({ type: 'varchar', name: 'feature_key' })
  featureKey!: BillingFeatureKey;

  @Column({ type: 'integer', name: 'limit_value' })
  limitValue!: number;

  @Column({ type: 'varchar', default: 'MONTHLY' })
  period!: 'MONTHLY';

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
