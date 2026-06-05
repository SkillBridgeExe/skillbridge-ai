import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('user_skills')
@Index(['userId', 'skillId'], { unique: true })
export class UserSkillEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Index()
  @Column('uuid', { name: 'skill_id' })
  skillId!: string;

  @Column({ type: 'int' })
  level!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
