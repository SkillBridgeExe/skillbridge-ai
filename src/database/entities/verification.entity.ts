import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type VerificationPurpose = 'EMAIL_VERIFY' | 'PASSWORD_RESET';

/** Maps `verifications` - short-lived hashed tokens for email verification/reset flows. */
@Entity('verifications')
@Index(['userId', 'purpose'])
@Index(['expiresAt'])
export class VerificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar' })
  purpose!: VerificationPurpose;

  @Column({ type: 'varchar', name: 'value_hash' })
  valueHash!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'int', name: 'attempt_count', default: 0 })
  attemptCount!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
