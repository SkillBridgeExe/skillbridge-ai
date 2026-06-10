import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  BillingFeatureKey,
  BillingFeaturePeriod,
  BILLING_FEATURE_KEYS,
  DEFAULT_BILLING_FEATURE_PERIOD,
} from '../../common/constants/billing.constants';

export { BillingFeatureKey, BillingFeaturePeriod, BILLING_FEATURE_KEYS };

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

  @Column({ type: 'varchar', default: DEFAULT_BILLING_FEATURE_PERIOD })
  period!: BillingFeaturePeriod;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
