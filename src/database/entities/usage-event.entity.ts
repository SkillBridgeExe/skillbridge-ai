import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BillingFeatureKey } from './plan-feature.entity';

@Entity('usage_events')
export class UsageEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Index()
  @Column({ type: 'varchar', name: 'feature_key' })
  featureKey!: BillingFeatureKey;

  @Index()
  @Column('uuid', { name: 'subscription_id', nullable: true })
  subscriptionId!: string | null;

  @Column({ type: 'varchar', name: 'source_type', nullable: true })
  sourceType!: string | null;

  @Column('uuid', { name: 'source_id', nullable: true })
  sourceId!: string | null;

  @Index()
  @Column({ type: 'timestamptz', name: 'used_at', default: () => 'now()' })
  usedAt!: Date;
}
