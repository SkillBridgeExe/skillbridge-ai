import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CreditType } from './billing-credit-package.entity';

export type PaymentOrderPurpose =
  | 'SUBSCRIPTION'
  | 'CREDIT_PACKAGE'
  | 'MENTOR_BOOKING'
  | 'MENTOR_DEPOSIT'
  | 'MENTOR_REMAINING';
export type PaymentOrderStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type PaymentOrderProviderVerificationStatus =
  | 'CONFIRMED_PAID'
  | 'NOT_PAID'
  | 'NOT_FOUND'
  | 'MISMATCH'
  | 'ERROR';
export type PaymentOrderTargetType = 'SUBSCRIPTION' | 'CREDIT_PACKAGE' | 'MENTOR_BOOKING';

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

  @Column({ type: 'integer', name: 'original_amount_vnd' })
  originalAmountVnd!: number;

  @Column({ type: 'smallint', name: 'discount_percent', default: 0 })
  discountPercent!: number;

  @Column({ type: 'integer', name: 'discount_amount_vnd', default: 0 })
  discountAmountVnd!: number;

  @Index()
  @Column('uuid', { name: 'voucher_id', nullable: true })
  voucherId!: string | null;

  @Column({ type: 'varchar', name: 'voucher_code', nullable: true })
  voucherCode!: string | null;

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

  @Column({ type: 'varchar', name: 'credit_type', nullable: true })
  creditType!: CreditType | null;

  @Column({ type: 'integer', name: 'credit_units', nullable: true })
  creditUnits!: number | null;

  @Index()
  @Column({ type: 'varchar' })
  status!: PaymentOrderStatus;

  @Column({ type: 'varchar', name: 'provider_verification_status', nullable: true })
  providerVerificationStatus!: PaymentOrderProviderVerificationStatus | null;

  @Column({ type: 'timestamptz', name: 'provider_verified_at', nullable: true })
  providerVerifiedAt!: Date | null;

  @Column({ type: 'varchar' })
  description!: string;

  @Column({ type: 'text', name: 'checkout_url', nullable: true })
  checkoutUrl!: string | null;

  @Column({ type: 'text', name: 'return_url', nullable: true })
  returnUrl!: string | null;

  @Column({ type: 'text', name: 'cancel_url', nullable: true })
  cancelUrl!: string | null;

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

  @Column({ type: 'timestamptz', name: 'last_provider_check_at', nullable: true })
  lastProviderCheckAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
