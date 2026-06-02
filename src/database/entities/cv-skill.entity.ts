import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('cv_skills')
@Index(['cvId', 'skillId'], { unique: true })
export class CvSkillEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'cv_id' })
  cvId!: string;

  @Index()
  @Column('uuid', { name: 'skill_id' })
  skillId!: string;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  confidence!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
