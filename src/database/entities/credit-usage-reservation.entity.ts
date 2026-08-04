import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CreditType } from './billing-credit-package.entity';

export type CreditUsageReservationStatus = 'RESERVED' | 'CONSUMED' | 'RELEASED';

@Entity('credit_usage_reservations')
export class CreditUsageReservationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Index()
  @Column({ type: 'varchar', name: 'credit_type' })
  creditType!: CreditType;

  @Column({ type: 'varchar' })
  status!: CreditUsageReservationStatus;

  @Column({ type: 'varchar', name: 'source_type', nullable: true })
  sourceType!: string | null;

  @Column('uuid', { name: 'source_id', nullable: true })
  sourceId!: string | null;

  @Column({ type: 'timestamptz', name: 'reserved_until' })
  reservedUntil!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
