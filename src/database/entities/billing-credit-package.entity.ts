import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BillingPlanEntity } from './billing-plan.entity';

export type CreditType = 'CV_ANALYSIS' | 'INTERVIEW_SESSION';

@Entity('billing_credit_packages')
export class BillingCreditPackageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', name: 'plan_code', unique: true })
  planCode!: string;

  @Column({ type: 'varchar', name: 'credit_type' })
  creditType!: CreditType;

  @Column({ type: 'integer' })
  units!: number;

  @OneToOne(() => BillingPlanEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_code', referencedColumnName: 'code' })
  plan!: BillingPlanEntity;
}
