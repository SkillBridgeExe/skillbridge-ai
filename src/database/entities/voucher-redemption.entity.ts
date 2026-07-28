import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type VoucherRedemptionStatus = 'RESERVED' | 'REDEEMED' | 'RELEASED';

@Entity('voucher_redemptions')
@Index(['voucherId', 'status', 'reservedUntil'])
@Index(['voucherId', 'userId', 'status'])
export class VoucherRedemptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'voucher_id' })
  voucherId!: string;

  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Index({ unique: true })
  @Column('uuid', { name: 'payment_order_id', nullable: true })
  paymentOrderId!: string | null;

  @Column({ type: 'varchar' })
  status!: VoucherRedemptionStatus;

  @Column({ type: 'timestamptz', name: 'reserved_until' })
  reservedUntil!: Date;

  @Column({ type: 'timestamptz', name: 'redeemed_at', nullable: true })
  redeemedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
