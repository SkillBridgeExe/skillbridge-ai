import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('vouchers')
export class VoucherEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'smallint', name: 'discount_percent' })
  discountPercent!: number;

  @Index()
  @Column({ type: 'varchar', name: 'applicable_plan_code' })
  applicablePlanCode!: string;

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
