import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('cv_consent_audits')
@Index(['userId', 'cvId'])
export class CvConsentAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Index()
  @Column('uuid', { name: 'cv_id' })
  cvId!: string;

  @Column({ type: 'varchar', name: 'consent_version' })
  consentVersion!: string;

  @Column({ type: 'varchar', name: 'consent_source' })
  consentSource!: string;

  @Column({ type: 'timestamptz', name: 'accepted_at' })
  acceptedAt!: Date;

  @Index()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
