import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('user_profiles')
export class UserProfileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', nullable: true })
  university!: string | null;

  @Column({ type: 'varchar', nullable: true })
  major!: string | null;

  @Column({ type: 'int', name: 'experience_years', nullable: true })
  experienceYears!: number | null;

  @Index()
  @Column({ type: 'varchar', name: 'target_job', nullable: true })
  targetJob!: string | null;

  @Column({ type: 'text', name: 'career_goal', nullable: true })
  careerGoal!: string | null;

  @Column({ type: 'text', name: 'github_url', nullable: true })
  githubUrl!: string | null;

  @Column({ type: 'text', name: 'linkedin_url', nullable: true })
  linkedinUrl!: string | null;

  @Column({ type: 'text', name: 'portfolio_url', nullable: true })
  portfolioUrl!: string | null;

  @Index()
  @Column('uuid', { name: 'document_id', nullable: true })
  documentId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
