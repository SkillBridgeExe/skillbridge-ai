import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CreditType } from './billing-credit-package.entity';

export type VoucherBenefitType = 'PERCENT_DISCOUNT' | 'CREDIT_GRANT';

@Entity('vouchers')
export class VoucherEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'varchar', name: 'benefit_type', default: 'PERCENT_DISCOUNT' })
  benefitType!: VoucherBenefitType;

  @Column({ type: 'smallint', name: 'discount_percent', nullable: true })
  discountPercent!: number | null;

  @Index()
  @Column({ type: 'varchar', name: 'applicable_plan_code', nullable: true })
  applicablePlanCode!: string | null;

  @Column({ type: 'varchar', name: 'credit_type', nullable: true })
  creditType!: CreditType | null;

  @Column({ type: 'integer', name: 'credit_units', nullable: true })
  creditUnits!: number | null;

  @Column({ type: 'timestamptz', name: 'starts_at' })
  startsAt!: Date;

  @Column({ type: 'timestamptz', name: 'ends_at' })
  endsAt!: Date;

  @Column({ type: 'integer', name: 'max_redemptions' })
  maxRedemptions!: number;

  @Column({ type: 'integer', name: 'per_user_limit', default: 1 })
  perUserLimit!: number;

  @Index()
  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ type: 'text', name: 'internal_note', nullable: true })
  internalNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
