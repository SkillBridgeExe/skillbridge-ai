import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payment_webhook_events')
export class PaymentWebhookEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', default: 'PAYOS' })
  provider!: string;

  @Index()
  @Column({ type: 'bigint', name: 'order_code', nullable: true })
  orderCode!: string | null;

  @Index()
  @Column({ type: 'varchar', nullable: true })
  reference!: string | null;

  @Column({ type: 'varchar', name: 'payment_link_id', nullable: true })
  paymentLinkId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  signature!: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', name: 'event_hash' })
  eventHash!: string;

  @Column({ type: 'jsonb', name: 'raw_payload' })
  rawPayload!: unknown;

  @Column({ type: 'boolean', default: false })
  verified!: boolean;

  @Column({ type: 'boolean', default: false })
  processed!: boolean;

  @Column({ type: 'text', name: 'processing_error', nullable: true })
  processingError!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
