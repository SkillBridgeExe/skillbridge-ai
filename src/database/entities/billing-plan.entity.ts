import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type BillingPlanCategory = 'SUBSCRIPTION' | 'MENTOR_PACKAGE';
export type BillingPlanInterval = 'MONTHLY' | 'ONE_TIME';

@Entity('billing_plans')
export class BillingPlanEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  code!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Index()
  @Column({ type: 'varchar' })
  category!: BillingPlanCategory;

  @Column({ type: 'varchar' })
  interval!: BillingPlanInterval;

  @Column({ type: 'integer', name: 'price_vnd', default: 0 })
  priceVnd!: number;

  @Column({ type: 'varchar', default: 'VND' })
  currency!: string;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ type: 'integer', name: 'sort_order', default: 0 })
  sortOrder!: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: unknown | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
