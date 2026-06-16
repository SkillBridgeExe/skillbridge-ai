import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('mentor_profile_skills')
@Index(['mentorProfileId', 'skillId'], { unique: true })
export class MentorProfileSkillEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'mentor_profile_id' })
  mentorProfileId!: string;

  @Index()
  @Column('uuid', { name: 'skill_id' })
  skillId!: string;

  @Column({ type: 'integer', name: 'sort_order', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
