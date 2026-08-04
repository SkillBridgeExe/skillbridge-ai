import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { CreditType } from './billing-credit-package.entity';

@Entity('user_credit_balances')
export class UserCreditBalanceEntity {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId!: string;

  @PrimaryColumn({ type: 'varchar', name: 'credit_type' })
  creditType!: CreditType;

  @Column({ type: 'integer', default: 0 })
  balance!: number;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
