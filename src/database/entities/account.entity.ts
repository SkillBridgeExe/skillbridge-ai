import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AuthProvider = 'CREDENTIALS' | 'GOOGLE';

/** Maps `accounts` — holds password_hash for CREDENTIALS, provider id for GOOGLE. */
@Entity('accounts')
@Index(['provider', 'providerAccountId'], { unique: true })
export class AccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar' })
  provider!: AuthProvider;

  @Column({ type: 'varchar', name: 'provider_account_id' })
  providerAccountId!: string;

  @Column({ type: 'varchar', name: 'password_hash', nullable: true })
  passwordHash!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
