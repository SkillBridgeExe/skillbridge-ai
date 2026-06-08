import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type PaymentOrderPurpose = 'SUBSCRIPTION' | 'MENTOR_DEPOSIT' | 'MENTOR_REMAINING';
export type PaymentOrderStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type PaymentOrderTargetType = 'SUBSCRIPTION' | 'MENTOR_BOOKING';

@Entity('payment_orders')
export class PaymentOrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', default: 'PAYOS' })
  provider!: string;

  @Index({ unique: true })
  @Column({ type: 'bigint', name: 'order_code' })
  orderCode!: string;

  @Column({ type: 'integer', name: 'amount_vnd' })
  amountVnd!: number;

  @Column({ type: 'varchar', default: 'VND' })
  currency!: string;

  @Index()
  @Column({ type: 'varchar' })
  purpose!: PaymentOrderPurpose;

  @Index()
  @Column({ type: 'varchar', name: 'target_type' })
  targetType!: PaymentOrderTargetType;

  @Index()
  @Column('uuid', { name: 'target_id', nullable: true })
  targetId!: string | null;

  @Column({ type: 'varchar', name: 'plan_code', nullable: true })
  planCode!: string | null;

  @Index()
  @Column({ type: 'varchar' })
  status!: PaymentOrderStatus;

  @Column({ type: 'varchar' })
  description!: string;

  @Column({ type: 'text', name: 'checkout_url', nullable: true })
  checkoutUrl!: string | null;

  @Column({ type: 'varchar', name: 'payment_link_id', nullable: true })
  paymentLinkId!: string | null;

  @Column({ type: 'text', name: 'qr_code', nullable: true })
  qrCode!: string | null;

  @Column({ type: 'jsonb', name: 'provider_payload', nullable: true })
  providerPayload!: unknown | null;

  @Column({ type: 'timestamptz', name: 'paid_at', nullable: true })
  paidAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
